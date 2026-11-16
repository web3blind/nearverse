// Minimal client for the public NEAR Intents 1Click API. Only fixed paths on a
// fixed base URL are called; responses are size-capped, time-limited and validated,
// and no free text from upstream reaches the agent.
export class OneClickError extends Error { constructor(public code: string) { super(code); } }
export interface QuoteInput { originAsset: string; destinationAsset: string; amount: string; owner: string; deadline: string }
export interface Quote { depositAddress: string; amountIn: string; amountOut: string; minAmountOut: string; amountInUsd: number; amountOutUsd: number; amountInFormatted?: string; amountOutFormatted?: string; timeEstimate?: number; deadline?: number }
export interface Token { symbol: string; assetId: string; decimals: number; price: number }
export interface OneClick { quote(input: QuoteInput): Promise<Quote>; status(depositAddress: string): Promise<string>; nearTokens(): Promise<Token[]> }

// Same account rule as the arrival verifier (server/upstream.ts), so every quoted token is verifiable.
export const nearAccount = (v: string) => v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const units = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,77}$/.test(v);
const usd = (v: unknown) => typeof v === 'string' && /^[0-9]{1,12}(\.[0-9]{1,12})?$/.test(v) ? Number(v) : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : NaN;
const formatted = (v: unknown) => typeof v === 'string' && /^[0-9.]{1,40}$/.test(v) ? v : undefined;
const STATUSES = ['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'];

export function oneClick(base = 'https://1click.chaindefuser.com', perMinute = 15, timeoutMs = 10000): OneClick {
  // One process-wide budget: the main site verifies human arrivals against the same host from the same IP.
  let window = 0; let used = 0;
  async function send(path: string, init: RequestInit = {}, cap = 65536) {
    const now = Date.now(); if (now - window >= 60000) { window = now; used = 0; }
    if (++used > perMinute) throw new OneClickError('intents_budget_busy');
    let res: Response;
    try { res = await fetch(base + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }); }
    catch { throw new OneClickError('intents_unavailable'); }
    if (Number(res.headers.get('content-length') || 0) > cap) throw new OneClickError('intents_response_too_large');
    const reader = res.body?.getReader(); if (!reader) throw new OneClickError('intents_invalid_response');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > cap) throw new OneClickError('intents_response_too_large'); chunks.push(part.value); } }
    catch (e) { if (e instanceof OneClickError) throw e; throw new OneClickError('intents_unavailable'); }
    finally { await reader.cancel().catch(() => undefined); }
    let data: Record<string, any>; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new OneClickError('intents_invalid_response'); }
    if (!res.ok) throw new OneClickError(res.status === 429 ? 'intents_rate_limited' : res.status >= 500 ? 'intents_unavailable' : 'intents_quote_refused');
    return data;
  }
  let cache: { at: number; list?: Token[] } | undefined;
  const statusCache = new Map<string, { at: number; status: string }>();
  return {
    async nearTokens() {
      // Cache successes for 10 minutes and failures for 1 minute, so a failing list is not refetched on every call.
      if (cache && Date.now() - cache.at < (cache.list ? 600000 : 60000)) { if (cache.list) return cache.list; throw new OneClickError('intents_unavailable'); }
      try {
        const d = await send('/v0/tokens', {}, 1 << 20) as unknown as Array<Record<string, unknown>>;
        if (!Array.isArray(d)) throw new OneClickError('intents_invalid_response');
        const list = d.filter(t => t.blockchain === 'near' && typeof t.assetId === 'string' && t.assetId.startsWith('nep141:') && nearAccount(t.assetId.slice(7))
          && typeof t.symbol === 'string' && /^[A-Za-z0-9.$_-]{1,16}$/.test(t.symbol) && Number.isInteger(t.decimals) && (t.decimals as number) >= 0 && (t.decimals as number) <= 36
          && usd(t.price) > 0).map(t => ({ symbol: t.symbol as string, assetId: t.assetId as string, decimals: t.decimals as number, price: usd(t.price) }));
        cache = { at: Date.now(), list }; return list;
      } catch (e) { cache = { at: Date.now() }; throw e; }
    },
    async quote(i) {
      // Same request shape the site uses: funds arrive in the owner's NEAR Intents
      // account, refunds go back to the owner on NEAR. The deposit is a single NEAR transaction.
      const d = await send('/v0/quote', { method: 'POST', body: JSON.stringify({ dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100,
        originAsset: i.originAsset, depositType: 'ORIGIN_CHAIN', destinationAsset: i.destinationAsset, amount: i.amount,
        refundTo: i.owner, refundType: 'ORIGIN_CHAIN', recipient: i.owner, recipientType: 'INTENTS', deadline: i.deadline }) });
      const q = d.quote; const r = d.quoteRequest;
      if (!q || !r || r.dry !== false || r.swapType !== 'EXACT_INPUT' || r.depositType !== 'ORIGIN_CHAIN' || r.refundType !== 'ORIGIN_CHAIN' || r.recipientType !== 'INTENTS'
        || r.recipient !== i.owner || r.refundTo !== i.owner || r.originAsset !== i.originAsset || r.destinationAsset !== i.destinationAsset
        || typeof q.depositAddress !== 'string' || !nearAccount(q.depositAddress) || q.depositMemo
        || !units(q.amountIn) || q.amountIn !== i.amount || !units(q.amountOut) || !units(q.minAmountOut)) throw new OneClickError('intents_unexpected_quote');
      // Slippage requested is 1%: anything wider is not what we asked for (seen live: out 312270, min 309147).
      const out = BigInt(q.amountOut); const min = BigInt(q.minAmountOut);
      // 1Click rounds the minimum down by up to one base unit.
    if (min > out || (min + 1n) * 100n < out * 99n) throw new OneClickError('intents_unexpected_slippage');
      const inUsd = usd(q.amountInUsd); const outUsd = usd(q.amountOutUsd);
      if (!(inUsd > 0) || !(outUsd > 0)) throw new OneClickError('intents_no_usd_price');
      const deadline = typeof q.deadline === 'string' && Number.isFinite(Date.parse(q.deadline)) ? Date.parse(q.deadline) : undefined;
      return { depositAddress: q.depositAddress, amountIn: q.amountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut, amountInUsd: inUsd, amountOutUsd: outUsd,
        amountInFormatted: formatted(q.amountInFormatted), amountOutFormatted: formatted(q.amountOutFormatted),
        timeEstimate: typeof q.timeEstimate === 'number' && Number.isFinite(q.timeEstimate) ? Math.round(q.timeEstimate) : undefined, deadline };
    },
    async status(depositAddress) {
      const hit = statusCache.get(depositAddress); if (hit && Date.now() - hit.at < 10000) return hit.status;
      const d = await send('/v0/status?depositAddress=' + encodeURIComponent(depositAddress));
      const status = STATUSES.includes(d.status) ? d.status : 'UNKNOWN';
      if (statusCache.size > 1000) statusCache.clear(); statusCache.set(depositAddress, { at: Date.now(), status }); return status;
    },
  };
}
