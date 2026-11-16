import { randomBytes } from 'node:crypto';
import { systems, regions } from '../src/world';
import { assetIds } from '../src/assets';
import { MainApiError, type MainClient } from './main-client';
import type { Link, McpStore } from './store';
import type { OneClick } from './oneclick';

interface Event { type: string; systemId: string; storyId?: string; createdAt: number; readyAt?: number }
type Args = Record<string, unknown>;
export interface ToolContext { client: MainClient; link: Link; store: McpStore; intents: OneClick; now: () => number }
export class ToolError extends Error {}
const eventId = () => 'mcp-' + randomBytes(12).toString('base64url');
const QUOTE_TTL = 15 * 60000;
const empty = { type: 'object', properties: {}, additionalProperties: false } as const;

export const toolDefinitions = [
  { name: 'list_systems', description: 'List NearVerse star systems. A system and its chapters open only after this account makes a confirmed swap into the system\'s asset (use get_swap_quote, send the deposit, then verify_arrival). Closed systems show only their name and asset.', inputSchema: empty },
  { name: 'list_swap_tokens', description: 'List NEAR tokens that can be used as the source of a swap (symbol, assetId, decimals).', inputSchema: empty },
  { name: 'get_limits', description: 'Show the spending limits set by the token owner and how much was reserved in the last 24 hours (USD).', inputSchema: empty },
  { name: 'get_swap_quote', description: 'Get a NEAR Intents quote to travel to a system: swap `amount` of `fromToken` (symbol or assetId from list_swap_tokens; human units, e.g. "0.1") into the system\'s asset. Checks the owner\'s limits. Returns a deposit address and the exact single NEAR transaction your own wallet tool must sign and send from this account. NearVerse never holds keys or funds.', inputSchema: { type: 'object', properties: { systemId: { type: 'string' }, fromToken: { type: 'string' }, amount: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' } }, required: ['systemId', 'fromToken', 'amount'], additionalProperties: false } },
  { name: 'verify_arrival', description: 'After sending the deposit for a quote, check the swap. When NEAR Intents reports SUCCESS, the arrival is verified by the server and the system opens. Call again while the status is pending.', inputSchema: { type: 'object', properties: { quoteId: { type: 'string' } }, required: ['quoteId'], additionalProperties: false } },
  { name: 'get_journal', description: 'Return the latest confirmed ship journal events (arrivals, expeditions, chapters read).', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { name: 'start_expedition', description: 'Start the next chapter expedition in a system this account has arrived in by swap. Only one expedition can be active. Takes about 15 seconds.', inputSchema: { type: 'object', properties: { systemId: { type: 'string' } }, required: ['systemId'], additionalProperties: false } },
  { name: 'complete_expedition', description: 'Complete the active expedition when it is ready and return the unlocked chapter text.', inputSchema: empty },
  { name: 'read_story', description: 'Return the text of a chapter this account has unlocked in a system it has arrived in by swap.', inputSchema: { type: 'object', properties: { systemId: { type: 'string' }, storyId: { type: 'string' } }, required: ['systemId', 'storyId'], additionalProperties: false } },
] as const;

// Agents see a system only after a verified swap into its asset; there is no free home system here.
function state(events: Event[]) {
  const arrived = new Set(events.filter(e => e.type === 'arrival').map(e => systems.find(s => s.id === e.systemId)?.asset));
  const open = (id: string) => { const s = systems.find(x => x.id === id); return !!s && arrived.has(s.asset); };
  const has = (type: string, systemId: string, storyId: string) => events.some(e => e.type === type && e.systemId === systemId && e.storyId === storyId);
  const active = events.find(e => e.type === 'expedition.started' && !has('expedition.completed', e.systemId, e.storyId!));
  const unread = events.find(e => e.type === 'expedition.completed' && !has('story.read', e.systemId, e.storyId!));
  return { open, has, active, unread };
}
const system = (id: unknown) => { const s = systems.find(x => x.id === id); if (!s) throw new ToolError('Unknown systemId. Call list_systems for valid ids.'); return s; };
const locked = (s: (typeof systems)[number]) => new ToolError(`${s.name} is closed. Arrive by swap first: get_swap_quote with systemId "${s.id}", send the deposit, then verify_arrival.`);
const chapter = (systemId: string, storyId: string) => { const s = system(systemId); const st = s.stories.find(x => x.id === storyId)!; return { system: s.name, chapter: s.stories.indexOf(st) + 1, title: st.title, text: st.text }; };
const toUnits = (amount: string, decimals: number) => {
  const [whole, frac = ''] = amount.split('.'); if (frac.length > decimals) throw new ToolError(`Too many decimal places: this token has ${decimals}.`);
  const units = BigInt(whole + frac.padEnd(decimals, '0')); if (units <= 0n) throw new ToolError('Amount must be greater than zero.'); return units.toString();
};

export function depositTransaction(originAsset: string, depositAddress: string, amountIn: string) {
  const contract = originAsset.slice('nep141:'.length);
  const ft = { receiverId: contract, actions: [
    { type: 'FunctionCall', methodName: 'storage_deposit', args: { account_id: depositAddress }, gas: '30000000000000', deposit: '1250000000000000000000' },
    { type: 'FunctionCall', methodName: 'ft_transfer', args: { receiver_id: depositAddress, amount: amountIn }, gas: '30000000000000', deposit: '1' },
  ] };
  const rules = 'Sign and send exactly ONE transaction, from signerId, once. Do not add a memo or other arguments to ft_transfer, do not split the amount, do not use ft_transfer_call, never reuse this depositAddress. Otherwise the arrival cannot be verified and the system stays closed. If unsure whether it was sent, call verify_arrival instead of sending again.';
  return contract === 'wrap.near'
    ? { rules, preferred: { receiverId: depositAddress, actions: [{ type: 'Transfer', deposit: amountIn }] }, alternative: ft, note: 'fromToken wNEAR is paid with plain native NEAR: send amountIn yoctoNEAR as a Transfer. The network also charges about 0.01 NEAR on top (gas and creating the deposit account), so keep that much extra.' }
    : { rules, transaction: ft, note: 'storage_deposit in the same transaction registers the deposit address with the token contract; keep it. Its 0.00125 NEAR and gas are paid on top of amountIn.' };
}

async function runSwapTool(name: string, args: Args, c: ToolContext, events: () => Promise<Event[]>) {
  const { link, store, intents, now } = c;
  if (name === 'list_swap_tokens') return (await intents.nearTokens()).map(t => ({ symbol: t.symbol, assetId: t.assetId, decimals: t.decimals }));
  if (name === 'get_limits') return { perSwapUsd: link.limits.perSwapUsd, dailyUsd: link.limits.dailyUsd, reservedLast24hUsd: store.spentCents(link, now()) / 100, setBy: 'token owner on the /mcp/ page', scope: 'daily limit is summed for the whole account', note: 'Unpaid quotes count until they are verified as expired (verify_arrival, one hour after sendBefore), refunded or failed.' };
  if (name === 'get_swap_quote') {
    const s = system(args.systemId);
    if (typeof args.amount !== 'string' || !/^[0-9]{1,30}(\.[0-9]{1,30})?$/.test(args.amount)) throw new ToolError('amount must be a decimal string such as "0.1".');
    const tokens = await intents.nearTokens(); const from = String(args.fromToken ?? '');
    const matches = tokens.filter(t => t.assetId === from || t.symbol.toLowerCase() === from.toLowerCase());
    if (matches.length !== 1) throw new ToolError(matches.length ? 'Several tokens share this symbol; pass the assetId.' : 'Unknown fromToken. Call list_swap_tokens.');
    const token = matches[0]; const destination = assetIds[s.asset];
    if (token.assetId === destination) throw new ToolError(`You already hold ${s.asset}; choose a different source token.`);
    // Paying again for an asset already reached unlocks nothing.
    const reached = state(await events()); if (reached.open(s.id)) throw new ToolError(`${s.name} is already open. Call start_expedition, or travel to a closed system.`);
    const pending = store.openQuote(link, destination, now());
    if (pending) throw new ToolError(`An unpaid quote ${pending.quoteId} for this asset is still valid until ${new Date(pending.deadline).toISOString()}. Use it (send its deposit once, then verify_arrival) or wait until it expires. Do not pay twice.`);
    const amount = toUnits(args.amount, token.decimals); let deadline = now() + QUOTE_TTL;
    // Cheap limit check before spending a shared 1Click call.
    const roughCents = Math.ceil(Number(amount) / 10 ** token.decimals * token.price * 100);
    if (roughCents > Math.round(link.limits.perSwapUsd * 100)) throw new ToolError(`This swap is about $${(roughCents / 100).toFixed(2)}; the per-swap limit is $${link.limits.perSwapUsd}. Choose a smaller amount.`);
    if (store.spentCents(link, now()) + roughCents > Math.round(link.limits.dailyUsd * 100)) throw new ToolError(`Daily limit of $${link.limits.dailyUsd} for this account would be exceeded. Choose a smaller amount or wait.`);
    const q = await intents.quote({ originAsset: token.assetId, destinationAsset: destination, amount, owner: link.owner, deadline: new Date(deadline).toISOString() });
    if (q.deadline) deadline = Math.min(deadline, q.deadline);
    // Limits use the larger of the quote's price and our own token-list price, so a missing or odd price cannot shrink a swap.
    const ownUsd = Number(amount) / 10 ** token.decimals * token.price; const valueUsd = Math.max(q.amountInUsd, ownUsd);
    if (!(valueUsd > 0) || !Number.isFinite(valueUsd)) throw new ToolError('No reliable USD price for this swap; choose another source token.');
    if (q.amountOutUsd < valueUsd * 0.95) throw new ToolError(`Bad rate: about $${valueUsd.toFixed(2)} in for $${q.amountOutUsd.toFixed(2)} out. Not prepared; try a different token or amount.`);
    const usdCents = Math.ceil(valueUsd * 100);
    const row = store.reserveQuote(link, { systemId: s.id, originAsset: token.assetId, destinationAsset: destination, depositAddress: q.depositAddress, amountIn: q.amountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut, usdCents, createdAt: now(), deadline }, now());
    if ('refused' in row) throw new ToolError(row.refused + ' Ask the owner to raise the limit on the /mcp/ page or choose a smaller amount.');
    return { quoteId: row.quoteId, system: s.name, signerId: link.owner, from: `${q.amountInFormatted ?? args.amount} ${token.symbol}`, to: `${q.amountOutFormatted ?? q.amountOut} ${s.asset}`,
      valueInUsd: Number(valueUsd.toFixed(2)), valueOutUsd: Number(q.amountOutUsd.toFixed(2)), amountOut: q.amountOut, minAmountOut: q.minAmountOut,
      depositAddress: q.depositAddress, amountIn: q.amountIn, sendBefore: new Date(deadline).toISOString(), estimatedSeconds: q.timeEstimate,
      deposit: depositTransaction(token.assetId, q.depositAddress, q.amountIn), next: 'After the transaction is final, call verify_arrival with this quoteId.' };
  }
  // verify_arrival
  const q = typeof args.quoteId === 'string' ? store.quote(link, args.quoteId) : undefined;
  if (!q) throw new ToolError('Unknown quoteId for this account.');
  const s = system(q.systemId);
  // Post (again) when the journal lacks this arrival, e.g. after it was deleted on the site; the event id is stable per quote.
  if (q.state !== 'ARRIVED' || !state(await events()).open(s.id)) {
    const status = await intents.status(q.depositAddress);
    if (status !== 'SUCCESS') {
      if (['REFUNDED', 'FAILED'].includes(status) || (status === 'PENDING_DEPOSIT' && now() > q.deadline + 60 * 60000)) store.setQuoteState(link, q.quoteId, status === 'PENDING_DEPOSIT' ? 'EXPIRED' : status);
      const hints: Record<string, string> = {
        PENDING_DEPOSIT: 'No deposit seen yet. Detection can take up to a minute after the transaction is final. If you have not sent it, send the deposit transaction from get_swap_quote; then wait for finality and call again. Do not send twice.',
        INCOMPLETE_DEPOSIT: 'The deposit is smaller than amountIn. Do not top it up; the swap will be refunded. Get a new quote later.',
        REFUNDED: 'The swap did not complete; funds were refunded to this account. Get a new quote.', FAILED: 'The swap failed; funds are refunded to this account. Get a new quote.' };
      return { arrived: false, status, system: s.name, hint: hints[status] ?? 'Swap in progress. Call again in about 10 seconds.' };
    }
    try {
      await c.client.call(link.session, 'POST', '/api/events', { eventId: 'mcp-arrival-' + q.quoteId, type: 'arrival', systemId: s.id,
        proof: { depositAddress: q.depositAddress, originAsset: q.originAsset, destinationAsset: q.destinationAsset, amountIn: q.amountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut } });
    } catch (e) {
      if (e instanceof MainApiError && e.code === 'arrival_unverified') throw new ToolError('The swap succeeded, but the deposit does not match the required single transaction (for example a memo, a split amount or ft_transfer_call was used). The system stays closed; the swapped funds are in this account\'s NEAR Intents balance.');
      throw e;
    }
    store.setQuoteState(link, q.quoteId, 'ARRIVED');
  }
  const st = state(await events());
  return { arrived: true, system: s.name, open: st.open(s.id), next: `Call start_expedition with systemId "${s.id}".` };
}

export async function runTool(name: string, args: Args, c: ToolContext) {
  const { client, link, now } = c; const session = link.session;
  const events = async () => ((await client.call(session, 'GET', '/api/events')) as { events: Event[] }).events;
  const post = (body: Args) => client.call(session, 'POST', '/api/events', { eventId: eventId(), ...body });
  switch (name) {
    case 'list_swap_tokens': case 'get_limits': case 'get_swap_quote': case 'verify_arrival': return runSwapTool(name, args, c, events);
    case 'list_systems': {
      const st = state(await events());
      return systems.map(s => st.open(s.id)
        ? { systemId: s.id, name: s.name, subtitle: s.subtitle, planet: s.planet, asset: s.asset, region: regions.find(r => r.asset === s.asset)?.name, description: s.description, open: true,
            chaptersRead: s.stories.filter(x => st.has('story.read', s.id, x.id)).length, chaptersTotal: s.stories.length }
        : { systemId: s.id, name: s.name, asset: s.asset, assetId: assetIds[s.asset], open: false, howToOpen: `get_swap_quote with systemId "${s.id}", send the deposit, then verify_arrival.` });
    }
    case 'get_journal': {
      const limit = typeof args.limit === 'number' ? Math.min(100, Math.max(1, Math.floor(args.limit))) : 30;
      // Only systems reached by swap: nothing about other places or their chapters leaks through the journal.
      const list = await events(); const st = state(list);
      return list.filter(e => st.open(e.systemId)).slice(-limit).reverse().map(e => ({ type: e.type, system: systems.find(s => s.id === e.systemId)?.name, ...(e.storyId ? { story: systems.find(s => s.id === e.systemId)?.stories.find(x => x.id === e.storyId)?.title } : {}), at: new Date(e.createdAt).toISOString() }));
    }
    case 'start_expedition': {
      const s = system(args.systemId); const st = state(await events());
      if (!st.open(s.id)) throw locked(s);
      const busy = st.active ?? st.unread;
      if (busy && !st.open(busy.systemId)) throw new ToolError('An expedition started on the website is in progress in a system you have not reached. The owner must finish it on nearverse.space first.');
      if (st.active) throw new ToolError(`An expedition is already active in ${system(st.active.systemId).name}. Call complete_expedition.`);
      if (st.unread) throw new ToolError(`A completed chapter in ${system(st.unread.systemId).name} is waiting. Call complete_expedition to read it.`);
      const next = s.stories.find(x => !st.has('story.read', s.id, x.id));
      if (!next) return { system: s.name, done: true, message: 'All chapters in this system are already unlocked. Travel to another system.' };
      const r = await post({ type: 'expedition.started', systemId: s.id, storyId: next.id }) as { event: Event };
      return { system: s.name, chapter: s.stories.indexOf(next) + 1, readyAt: new Date(r.event.readyAt!).toISOString(), next: 'Call complete_expedition after readyAt.' };
    }
    case 'complete_expedition': {
      const list = await events(); const st = state(list);
      // A previous call may have completed the expedition but failed before marking it read.
      const target = st.active ?? st.unread;
      if (!target) {
        // A retry after a lost response: report the chapter that was just unlocked instead of failing.
        const last = [...list].reverse().find(e => e.type === 'story.read');
        if (last && st.open(last.systemId) && now() - last.createdAt < 10 * 60000) return { ready: true, alreadyCompleted: true, ...chapter(last.systemId, last.storyId!) };
        throw new ToolError('No active expedition. Call start_expedition first.');
      }
      if (!st.open(target.systemId)) throw new ToolError('An expedition started on the website is in progress in a system you have not reached. The owner must finish it on nearverse.space first.');
      if (st.active) {
        const wait = (st.active.readyAt ?? 0) - now();
        if (wait > 0) return { ready: false, secondsLeft: Math.ceil(wait / 1000) };
      }
      try {
        if (st.active) await post({ type: 'expedition.completed', systemId: target.systemId, storyId: target.storyId });
        await post({ type: 'story.read', systemId: target.systemId, storyId: target.storyId });
      } catch (e) {
        // A parallel call may have done the same writes; succeed if the chapter is now read.
        if (!(e instanceof MainApiError && e.status === 409) || !state(await events()).has('story.read', target.systemId, target.storyId!)) throw e;
      }
      return { ready: true, ...chapter(target.systemId, target.storyId!) };
    }
    case 'read_story': {
      const s = system(args.systemId); const st = state(await events());
      if (!st.open(s.id)) throw locked(s);
      if (typeof args.storyId !== 'string' || !s.stories.some(x => x.id === args.storyId)) throw new ToolError('Unknown storyId for this system.');
      if (!st.has('story.read', s.id, args.storyId)) throw new ToolError('This chapter is not unlocked yet.');
      return chapter(s.id, args.storyId);
    }
    default: throw new ToolError('Unknown tool.');
  }
}
