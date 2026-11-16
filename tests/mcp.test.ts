// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { createApp } from '../server/app';
import { nep413Hash, type Challenge } from '../server/auth';
import { openStore } from '../server/store';
import { openMcpStore, type McpStore } from '../mcp/store';
import { mainClient } from '../mcp/main-client';
import { createMcpApp } from '../mcp/app';
import { toolDefinitions } from '../mcp/tools';
import type { OneClick, QuoteInput } from '../mcp/oneclick';

// Offline stand-in for the NEAR Intents 1Click API.
let swapStatus = 'PENDING_DEPOSIT'; let usdPerQuote = '1.50'; let usdOut = 0; let quotes: QuoteInput[] = [];
const intents: OneClick = {
  async nearTokens() { return [{ symbol: 'wNEAR', assetId: 'nep141:wrap.near', decimals: 24, price: 0.000001 }, { symbol: 'USDC', assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, price: 1 }]; },
  async quote(i) { quotes.push(i); return { depositAddress: 'dep' + quotes.length + '.near', amountIn: i.amount, amountOut: '1000', minAmountOut: '990', amountInUsd: Number(usdPerQuote), amountOutUsd: usdOut || Number(usdPerQuote), amountOutFormatted: '0.001' }; },
  async status() { return swapStatus; },
};

const origin = 'http://localhost:5173';
const SECRET = 'test-agent-link-secret-0123456789abcdef';
const mc = (n = 200) => mainClient(mainBase, origin, n, 8000, SECRET);
let main: Server; let mcp: Server; let mainBase = ''; let mcpBase = ''; let time = 1800000000000;
let db: ReturnType<typeof openStore>; let store: McpStore; let dir = '';
const listen = async (s: Server) => { await once(s, 'listening'); return `http://127.0.0.1:${(s.address() as { port: number }).port}`; };
const close = (s: Server) => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); };

async function signed(accountId = 'alice.near') {
  const challenge = await (await fetch(mcpBase + '/mcp/api/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ accountId }) })).json() as Challenge;
  const key = KeyPair.fromRandom('ed25519'); // offline fixture, no wallet
  return { challengeId: challenge.id, accountId, publicKey: key.getPublicKey().toString(), signature: Buffer.from(key.sign(nep413Hash(challenge)).signature).toString('base64') };
}
async function link(accountId?: string) {
  const r = await fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(await signed(accountId)) });
  expect(r.status).toBe(201); return (await r.json()) as { token: string; accountId: string };
}
let rpcId = 0;
async function rpc(token: string, method: string, params?: unknown) {
  const r = await fetch(mcpBase + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: r.status, body: await r.json() as { result?: { content: { text: string }[]; isError?: boolean; structuredContent?: unknown; tools?: { name: string }[] }; error?: { message: string } } };
}
async function arrive(token: string, systemId = 'near-lada', fromToken = 'USDC') {
  const q = (await call(token, 'get_swap_quote', { systemId, fromToken, amount: '1.5' })).data as { quoteId: string };
  const before = swapStatus; swapStatus = 'SUCCESS'; const v = await call(token, 'verify_arrival', { quoteId: q.quoteId }); swapStatus = before; return v;
}
const call = async (token: string, name: string, args: Record<string, unknown> = {}) => { const r = await rpc(token, 'tools/call', { name, arguments: args }); return { isError: r.body.result!.isError, data: (r.body.result!.isError ? null : JSON.parse(r.body.result!.content[0].text)) as never, text: r.body.result!.content[0].text }; };

beforeEach(async () => {
  time = 1800000000000; swapStatus = 'PENDING_DEPOSIT'; usdPerQuote = '1.50'; usdOut = 0; quotes = []; db = openStore(); dir = mkdtempSync(join(tmpdir(), 'nv-mcp-'));
  main = createApp({ origin, db, now: () => time, verifyOwnership: async () => true, verifyArrival: async () => true, agentLinkSecret: SECRET }).listen(0, '127.0.0.1'); mainBase = await listen(main);
  store = openMcpStore(join(dir, 'mcp.sqlite'), randomBytes(32));
  writeFileSync(join(dir, 'index.html'), '<h1>Agent page</h1>');
  mcp = createMcpApp({ origin, store, client: mc(), now: () => time, staticDir: dir, perTokenPerMinute: 100, perOwnerMainPerMinute: 1000, challengesPerMinute: { perIp: 1000, total: 1000 }, intents }).listen(0, '127.0.0.1'); mcpBase = await listen(mcp);
});
afterEach(async () => { await close(mcp); await close(main); store.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('agent MCP module', () => {
  it('links an account by NEP-413 signature and plays a chapter through the existing history API', async () => {
    const { token, accountId } = await link();
    expect(accountId).toBe('alice.near'); expect(token).toMatch(/^nvmcp_/);
    // The agent grant is stated in the signed text and lasts 7 days.
    expect(store.find(token, time)!.expires).toBe(time + 7 * 86400000);
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'nearverse' } });
    expect((await rpc(token, 'tools/list')).body.result!.tools!.map(t => t.name)).toContain('start_expedition');
    // Nothing about places or chapters is given before a swap, not even for the NEAR home system.
    const closed = (await call(token, 'list_systems')).data as Record<string, unknown>[];
    expect(closed.every(s => s.open === false && !('description' in s) && !('planet' in s) && !('subtitle' in s))).toBe(true);
    expect((await call(token, 'start_expedition', { systemId: 'near-lada' })).text).toContain('get_swap_quote');
    expect((await call(token, 'read_story', { systemId: 'near-lada', storyId: 'lada-1' })).isError).toBe(true);
    const quote = (await call(token, 'get_swap_quote', { systemId: 'near-lada', fromToken: 'usdc', amount: '1.5' })).data as { quoteId: string; depositAddress: string; deposit: { transaction: { receiverId: string; actions: { methodName: string; args: Record<string, string> }[] } } };
    expect(quotes[0]).toMatchObject({ amount: '1500000', owner: 'alice.near', destinationAsset: 'nep141:wrap.near' });
    expect(quote.deposit.transaction.actions.at(-1)).toMatchObject({ methodName: 'ft_transfer', args: { receiver_id: quote.depositAddress, amount: '1500000' } });
    expect((await call(token, 'verify_arrival', { quoteId: quote.quoteId })).data).toMatchObject({ arrived: false, status: 'PENDING_DEPOSIT' });
    swapStatus = 'SUCCESS';
    expect((await call(token, 'verify_arrival', { quoteId: quote.quoteId })).data).toMatchObject({ arrived: true, open: true });
    expect((await call(token, 'verify_arrival', { quoteId: quote.quoteId })).data).toMatchObject({ arrived: true }); // idempotent
    const systems = (await call(token, 'list_systems')).data as { systemId: string; open: boolean; description?: string }[];
    expect(systems.find(s => s.systemId === 'near-lada')).toMatchObject({ open: true }); expect(systems.find(s => s.systemId === 'near-lada')!.description).toBeTruthy();
    expect(systems.find(s => s.systemId === 'btc-basalt')!.open).toBe(false);
    const locked = await call(token, 'start_expedition', { systemId: 'btc-basalt' }); expect(locked.isError).toBe(true);
    const started = await call(token, 'start_expedition', { systemId: 'near-lada' }); expect(started.isError).toBe(false);
    expect((await call(token, 'start_expedition', { systemId: 'near-echo' })).isError).toBe(true); // one active expedition
    expect((await call(token, 'complete_expedition')).data).toMatchObject({ ready: false });
    time += 16000;
    const done = (await call(token, 'complete_expedition')).data as { ready: boolean; title: string; text: string };
    expect(done.ready).toBe(true); expect(done.text.length).toBeGreaterThan(20);
    // The same events are visible to the human site through the unchanged API.
    expect((await call(token, 'read_story', { systemId: 'near-lada', storyId: 'lada-1' })).isError).toBe(false);
    expect((await call(token, 'read_story', { systemId: 'near-lada', storyId: 'lada-2' })).isError).toBe(true);
    const journal = (await call(token, 'get_journal')).data as { type: string }[];
    expect(journal.map(e => e.type)).toEqual(['story.read', 'expedition.completed', 'expedition.started', 'arrival']);
  });
  it('rejects missing, forged, foreign-origin and revoked tokens', async () => {
    expect((await rpc('nvmcp_' + 'x'.repeat(43), 'tools/list')).status).toBe(401);
    const { token } = await link();
    const foreign = await fetch(mcpBase + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'https://evil.test' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    expect(foreign.status).toBe(403);
    expect((await fetch(mcpBase + '/mcp/api/link', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await rpc(token, 'tools/list')).status).toBe(401);
  });
  it('refuses a replayed or tampered signature', async () => {
    const body = await signed();
    const post = (b: unknown) => fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    expect((await post({ ...body, accountId: 'mallory.near' })).status).toBe(401);
    expect((await post(body)).status).toBe(401); // the challenge was consumed by the first attempt
  });
  it('keeps agent tokens per account and stores no plaintext main session', async () => {
    const a = await link('alice.near'); const b = await link('bob.near'); await arrive(a.token);
    await call(a.token, 'start_expedition', { systemId: 'near-lada' });
    expect((await call(b.token, 'get_journal')).data).toEqual([]);
    expect((await call(b.token, 'verify_arrival', { quoteId: 'q_x' })).isError).toBe(true);
    const raw = (await import('better-sqlite3')).default; const peek = new raw(join(dir, 'mcp.sqlite'), { readonly: true });
    const rows = peek.prepare('SELECT * FROM links').all() as { id: string; session: Buffer }[]; peek.close();
    expect(rows.every(r => !r.id.startsWith('nvmcp_') && !/^[A-Za-z0-9_-]{43}$/.test(r.session.toString('utf8')))).toBe(true);
  });
  it('maps an unavailable history API to a tool error without crashing', async () => {
    const { token } = await link(); await close(main);
    const r = await call(token, 'list_systems'); expect(r.isError).toBe(true); expect(r.text).toContain('history_unavailable');
    expect((await fetch(mcpBase + '/mcp/api/health')).status).toBe(200);
  });
  it('serves the page at /mcp/ while /mcp stays the JSON-RPC endpoint', async () => {
    const page = await fetch(mcpBase + '/mcp/'); expect(page.status).toBe(200); expect(await page.text()).toContain('Agent page');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await fetch(mcpBase + '/mcp')).status).toBe(405);
  });
  it('follows JSON-RPC and MCP transport contracts', async () => {
    const { token } = await link();
    const raw = (body: string, headers: Record<string, string> = {}) => fetch(mcpBase + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body });
    const parse = await raw('{bad'); expect(parse.status).toBe(400); expect((await parse.json()).error.code).toBe(-32700);
    expect((await (await raw('{"jsonrpc":"2.0","id":{},"method":"ping"}')).json()).error.code).toBe(-32600);
    expect((await (await raw('{"jsonrpc":"2.0","id":1,"method":"ping"}', { 'MCP-Protocol-Version': '1999-01-01' })).json()).error.code).toBe(-32600);
    expect((await raw('{"jsonrpc":"2.0","id":1,"method":"ping"}', { 'MCP-Protocol-Version': '2025-06-18' })).status).toBe(200);
    const noParams = await rpc(token, 'initialize'); expect(noParams.status).toBe(200); expect(noParams.body.error).toBeTruthy();
    expect((await rpc(token, 'initialize', { protocolVersion: '1999-01-01' })).body.result).toMatchObject({ protocolVersion: '2025-06-18' });
    const unknown = await rpc(token, 'tools/call', { name: 'drain_wallet', arguments: {} }); expect(unknown.status).toBe(200); expect(unknown.body.error).toBeTruthy();
    const missing = await rpc(token, 'prompts/list'); expect(missing.status).toBe(200); expect((missing.body.error as unknown as { code: number }).code).toBe(-32601);
    expect((await raw('{"jsonrpc":"2.0","method":"notifications/initialized"}')).status).toBe(202);
    expect((await raw('{"jsonrpc":"2.0","id":5,"result":{}}')).status).toBe(202);
    expect((await fetch(mcpBase + '/mcp', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
    const expired = await fetch(mcpBase + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    expect(expired.headers.get('www-authenticate')).toContain('invalid_token');
  });
  it('returns the unlocked chapter again when a completion response was lost', async () => {
    const { token } = await link(); await arrive(token);
    await call(token, 'start_expedition', { systemId: 'near-lada' }); time += 16000;
    const first = (await call(token, 'complete_expedition')).data as { title: string };
    const retry = (await call(token, 'complete_expedition')).data as { title: string; alreadyCompleted: boolean };
    expect(retry).toMatchObject({ title: first.title, alreadyCompleted: true });
    time += 11 * 60000; expect((await call(token, 'complete_expedition')).isError).toBe(true);
  });
  it('rejects junk link requests before spending the shared history budget and limits per client', async () => {
    let verifyCalls = 0; const real = mc();
    const counting = { ...real, verify: (b: unknown) => { verifyCalls++; return real.verify(b); } };
    await close(mcp); mcp = createMcpApp({ origin, store, client: real, linkClient: counting, now: () => time, challengesPerMinute: { perIp: 1000, total: 1000 }, intents }).listen(0, '127.0.0.1'); mcpBase = await listen(mcp);
    const post = (b: unknown, ip = '203.0.113.1') => fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify(b) });
    for (let i = 0; i < 5; i++) expect((await post({ junk: i })).status).toBe(400);
    expect(verifyCalls).toBe(0);
    expect((await post({ junk: 6 })).status).toBe(400); expect((await post({ junk: 7 })).status).toBe(429);
    expect((await post(await signed(), '203.0.113.2')).status).toBe(201); // another visitor is unaffected
  });
  it('treats a token sealed under another secret as unknown instead of failing', async () => {
    const { token } = await link(); store.close();
    store = openMcpStore(join(dir, 'mcp.sqlite'), randomBytes(32));
    await close(mcp); mcp = createMcpApp({ origin, store, client: mc(), now: () => time, challengesPerMinute: { perIp: 1000, total: 1000 }, intents }).listen(0, '127.0.0.1'); mcpBase = await listen(mcp);
    expect((await rpc(token, 'tools/list')).status).toBe(401);
  });
  it('points the agent to a waiting chapter instead of a confusing history error', async () => {
    const { token } = await link(); await arrive(token); await call(token, 'start_expedition', { systemId: 'near-lada' }); time += 16000;
    // Simulate a completion recorded by the site without the read step.
    const session = store.find(token, time)!.session;
    await mc().call(session, 'POST', '/api/events', { eventId: 'site-complete-1', type: 'expedition.completed', systemId: 'near-lada', storyId: 'lada-1' });
    const r = await call(token, 'start_expedition', { systemId: 'near-lada' }); expect(r.isError).toBe(true); expect(r.text).toContain('complete_expedition');
    expect(((await call(token, 'complete_expedition')).data as { title: string }).title).toBeTruthy();
  });
  it('enforces the owner\'s per-swap and daily limits and releases refunded quotes', async () => {
    const r = await fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(await signed()), limits: { perSwapUsd: 2, dailyUsd: 3 } }) });
    const { token, limits } = await r.json() as { token: string; limits: unknown }; expect(limits).toEqual({ perSwapUsd: 2, dailyUsd: 3 });
    const q = (systemId: string) => call(token, 'get_swap_quote', { systemId, fromToken: 'wNEAR', amount: '1' });
    usdPerQuote = '2.01'; expect((await q('btc-basalt')).text).toContain('per-swap limit');
    usdPerQuote = '1.50'; const first = (await q('btc-basalt')).data as { quoteId: string; deposit: { preferred: { actions: { type: string }[] } } };
    expect(first.deposit.preferred.actions[0].type).toBe('Transfer'); // native NEAR for wNEAR
    expect((await q('btc-basalt')).text).toContain('Do not pay twice'); // one open quote per destination
    expect((await q('eth-prism')).isError).toBe(false);
    expect((await q('sol-pulse')).text).toContain('Daily limit');
    swapStatus = 'REFUNDED'; await call(token, 'verify_arrival', { quoteId: first.quoteId });
    expect((await q('sol-pulse')).isError).toBe(false); // the refunded quote no longer counts
    // Too large by the token-list price: refused before any 1Click call.
    const calls = quotes.length; expect((await call(token, 'get_swap_quote', { systemId: 'usdt-harbor', fromToken: 'USDC', amount: '50' })).text).toContain('per-swap limit'); expect(quotes.length).toBe(calls);
    expect((await call(token, 'get_limits')).data).toMatchObject({ perSwapUsd: 2, dailyUsd: 3, reservedLast24hUsd: 3 });
    const bad = await fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(await signed()), limits: { perSwapUsd: 5, dailyUsd: 1 } }) });
    expect(bad.status).toBe(400);
    expect((await call(token, 'get_swap_quote', { systemId: 'near-lada', fromToken: 'wNEAR', amount: '1' })).text).toContain('already hold');
  });
  it('refuses bad rates and paying again for an open system; hides closed systems from the journal', async () => {
    const { token } = await link();
    usdOut = 1.0; expect((await call(token, 'get_swap_quote', { systemId: 'btc-basalt', fromToken: 'USDC', amount: '1.5' })).text).toContain('Bad rate'); usdOut = 0;
    // Chapters played on the website in the free NEAR home system stay invisible to the agent until it swaps there.
    const session = store.find(token, time)!.session; const site = mc();
    // The site itself no longer has a free home system either.
    await expect(site.call(session, 'POST', '/api/events', { eventId: 'site-1', type: 'expedition.started', systemId: 'near-lada', storyId: 'lada-1' })).rejects.toMatchObject({ status: 409 });
    expect((await call(token, 'get_journal')).data).toEqual([]);
    await arrive(token, 'btc-basalt');
    expect((await call(token, 'get_swap_quote', { systemId: 'btc-ember', fromToken: 'USDC', amount: '1' })).text).toContain('already open');
    const journal = (await call(token, 'get_journal')).data as { system: string }[];
    expect(journal.map(e => e.system)).toEqual(['Basalt']);
  });
  it('lets any token of the same account finish a paid swap and sums spending per account', async () => {
    usdPerQuote = '4.00'; const a = await link(); const first = await call(a.token, 'get_swap_quote', { systemId: 'btc-basalt', fromToken: 'USDC', amount: '4' }); expect(first.text).toContain('quoteId'); const q = first.data as { quoteId: string };
    await fetch(mcpBase + '/mcp/api/link', { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}` } });
    const relink = await fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(await signed()), limits: { perSwapUsd: 5, dailyUsd: 8 } }) });
    const b = await relink.json() as { token: string }; swapStatus = 'SUCCESS';
    expect((await call(b.token, 'verify_arrival', { quoteId: q.quoteId })).data).toMatchObject({ arrived: true });
    expect((await call(b.token, 'get_limits')).data).toMatchObject({ reservedLast24hUsd: 4 });
    expect((await call(b.token, 'get_swap_quote', { systemId: 'usdt-harbor', fromToken: 'USDC', amount: '4' })).isError).toBe(false);
    expect((await call(b.token, 'get_swap_quote', { systemId: 'sol-pulse', fromToken: 'USDC', amount: '4' })).text).toContain('Daily limit');
  });
  it('caps its own load on the shared history API', async () => {
    const client = mainClient(mainBase, origin, 2); vi.useRealTimers();
    await client.call('x'.repeat(43), 'GET', '/api/health'); await client.call('x'.repeat(43), 'GET', '/api/health');
    await expect(client.call('x'.repeat(43), 'GET', '/api/health')).rejects.toMatchObject({ code: 'agent_budget_busy' });
  });
  it('issues 7-day agent grants only through the module; a browser keeps 24-hour sign-ins', async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(mainBase + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
    expect((await post('/api/auth/challenge', { accountId: 'alice.near', purpose: 'agent' })).status).toBe(403);
    expect((await post('/api/auth/challenge', { accountId: 'alice.near', purpose: 'admin' }, { 'X-NearVerse-Agent-Link': SECRET })).status).toBe(400);
    const site = await (await post('/api/auth/challenge', { accountId: 'alice.near' })).json() as Challenge;
    expect(site.message).toMatch(/^Sign in to NearVerse history/);
    const key = KeyPair.fromRandom('ed25519'); const sig = (c: Challenge) => Buffer.from(key.sign(nep413Hash(c)).signature).toString('base64');
    const v = await (await post('/api/auth/verify', { challengeId: site.id, accountId: 'alice.near', publicKey: key.getPublicKey().toString(), signature: sig(site) })).json() as { expiresAt: number; purpose: string };
    expect(v).toMatchObject({ purpose: 'site', expiresAt: time + 86400000 });
    // A site challenge cannot become an agent token.
    const r = await fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: site.id, accountId: 'alice.near', publicKey: key.getPublicKey().toString(), signature: sig(site) }) });
    expect(r.status).toBe(401);
    const agent = await (await fetch(mcpBase + '/mcp/api/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'alice.near' }) })).json() as Challenge;
    expect(agent.message).toContain('Grant an AI agent access to your NearVerse journal for 7 days. Sign only on ' + origin + '/mcp/.');
  });
  it('checks the signature locally before spending the history budget', async () => {
    let verifyCalls = 0; const real = mc();
    await close(mcp); mcp = createMcpApp({ origin, store, client: real, linkClient: { ...real, verify: (b: unknown) => { verifyCalls++; return real.verify(b); } }, now: () => time, challengesPerMinute: { perIp: 1000, total: 1000 }, intents }).listen(0, '127.0.0.1'); mcpBase = await listen(mcp);
    const good = await signed(); const other = KeyPair.fromRandom('ed25519');
    const r = await fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...good, publicKey: other.getPublicKey().toString() }) });
    expect(r.status).toBe(401); expect(verifyCalls).toBe(0);
  });
  it('revokes every token of the account at once', async () => {
    const a = await link(); const b = await link();
    const r = await fetch(mcpBase + '/mcp/api/link?all=1', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.token } });
    expect(await r.json()).toMatchObject({ ok: true, revoked: 2 });
    expect((await rpc(b.token, 'tools/list')).status).toBe(401);
  });
  it('treats every spelling of one IPv6 /64 as one client and caps challenges in total', async () => {
    await close(mcp); mcp = createMcpApp({ origin, store, client: mc(), now: () => time, challengesPerMinute: { perIp: 2, total: 3 }, intents }).listen(0, '127.0.0.1'); mcpBase = await listen(mcp);
    const post = (ip: string) => fetch(mcpBase + '/mcp/api/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify({ accountId: 'bad name' }) });
    expect((await post('2001:db8::1')).status).toBe(400); expect((await post('2001:0DB8:0:0::2')).status).toBe(400);
    expect((await post('2001:db8:0:0:1::3')).status).toBe(429); // same /64
    expect((await post('2001:db8:1::1')).status).toBe(400); // another client: third in total
    expect((await post('2001:db8:2::1')).status).toBe(429); // total cap of 3 reached
  });
  it('logs out a non-agent session and retries logouts that failed', async () => {
    const real = mc(); let fail = true; const logouts: string[] = [];
    const flaky = { ...real, logout: async (s: string) => { if (fail) throw new Error('busy'); logouts.push(s); } };
    await close(mcp); mcp = createMcpApp({ origin, store, client: real, logoutClient: flaky, now: () => time, challengesPerMinute: { perIp: 1000, total: 1000 }, intents }).listen(0, '127.0.0.1'); mcpBase = await listen(mcp);
    const { token } = await link(); const session = store.find(token, time)!.session;
    const r = await fetch(mcpBase + '/mcp/api/link', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); expect(r.status).toBe(200);
    await vi.waitFor(() => expect(store.takeLogouts(5)).toEqual([session]));
    fail = false; store.queueLogout(session); await flaky.logout(store.takeLogouts(5)[0]); expect(logouts).toEqual([session]);
  });
  it('refuses a session that is not an agent grant and ends it', async () => {
    const real = mc(); const ended: string[] = [];
    const site = { ...real, verify: async (x: unknown) => ({ ...(await real.verify(x)), purpose: 'site' }) };
    await close(mcp); mcp = createMcpApp({ origin, store, client: real, linkClient: site, logoutClient: { ...real, logout: async (s: string) => { ended.push(s); } }, now: () => time, challengesPerMinute: { perIp: 1000, total: 1000 }, intents }).listen(0, '127.0.0.1'); mcpBase = await listen(mcp);
    const r = await fetch(mcpBase + '/mcp/api/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await signed()) });
    expect(r.status).toBe(400); expect((await r.json()).error).toBe('agent_grant_required'); expect(ended).toHaveLength(1);
  });
  it('declares a fractional-amount pattern that accepts decimals', () => {
    const pattern = (toolDefinitions.find(t => t.name === 'get_swap_quote')!.inputSchema as { properties: { amount: { pattern: string } } }).properties.amount.pattern;
    expect(new RegExp(pattern).test('0.1')).toBe(true); expect(new RegExp(pattern).test('0x1')).toBe(false);
  });
  it('keeps one account from taking the whole shared history budget', async () => {
    await close(mcp); mcp = createMcpApp({ origin, store, client: mc(), now: () => time, perTokenPerMinute: 100, perOwnerMainPerMinute: 2, challengesPerMinute: { perIp: 1000, total: 1000 }, intents }).listen(0, '127.0.0.1'); mcpBase = await listen(mcp);
    const { token } = await link();
    await call(token, 'get_journal'); await call(token, 'get_journal');
    const busy = await call(token, 'get_journal'); expect(busy.isError).toBe(true); expect(busy.text).toContain('Wait about a minute');
    time += 61000; expect((await call(token, 'get_journal')).isError).toBe(false);
  });
});
