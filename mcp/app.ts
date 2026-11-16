import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { DEFAULT_LIMITS, MAX_LIMIT_USD, type Limits, type McpStore } from './store';
import { oneClick, OneClickError, type OneClick } from './oneclick';
import { MainApiError, type MainClient } from './main-client';
import { runTool, toolDefinitions, ToolError } from './tools';
import { verifySignature, type Challenge } from '../server/auth';
import { isIPv6 } from 'node:net';

export interface McpOptions { origin: string; store: McpStore; client: MainClient; linkClient?: MainClient; challengeClient?: MainClient; logoutClient?: MainClient; intents?: OneClick; staticDir?: string; now?: () => number; perTokenPerMinute?: number; perOwnerMainPerMinute?: number; challengesPerMinute?: { perIp: number; total: number } }
const PROTOCOLS = ['2025-06-18']; // batches (required by 2025-03-26) are not supported
const usd = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_LIMIT_USD && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
// Optional owner-chosen spending limits; defaults are conservative.
const parseLimits = (v: unknown): Limits | undefined | null => {
  if (v === undefined) return DEFAULT_LIMITS;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 2) return null;
  const { perSwapUsd, dailyUsd } = v as Record<string, unknown>;
  return usd(perSwapUsd) && usd(dailyUsd) && (perSwapUsd as number) <= (dailyUsd as number) ? { perSwapUsd: Math.round((perSwapUsd as number) * 100) / 100, dailyUsd: Math.round((dailyUsd as number) * 100) / 100 } : null;
};
// Full 8-group form, so every spelling of one IPv6 /64 maps to the same key.
const expand6 = (ip: string) => {
  const [head, tail = ''] = ip.split('::'); const h = head ? head.split(':') : []; const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.map(g => g.padStart(4, '0').toLowerCase());
};
const linkBody = (b: unknown) => !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).filter(k => k !== 'limits').length === 4 && Object.keys(b).length <= 5
  && typeof (b as Record<string, unknown>).challengeId === 'string' && /^[A-Za-z0-9_-]{43}$/.test((b as Record<string, string>).challengeId)
  && typeof (b as Record<string, unknown>).accountId === 'string' && /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test((b as Record<string, string>).accountId)
  && typeof (b as Record<string, unknown>).publicKey === 'string' && /^ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}$/.test((b as Record<string, string>).publicKey)
  && typeof (b as Record<string, unknown>).signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test((b as Record<string, string>).signature);
const bearer = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';

export function createMcpApp(o: McpOptions) {
  const now = o.now ?? Date.now; const app = express(); app.disable('x-powered-by');
  // nginx is the only peer on loopback and overwrites X-Real-IP; X-Forwarded-For is never trusted.
  app.set('trust proxy', false);
  const clientIp = (req: Request) => {
    const raw = (typeof req.headers['x-real-ip'] === 'string' && req.socket.remoteAddress && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ? req.headers['x-real-ip'] : req.socket.remoteAddress) || 'unknown';
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)?.[1]; if (v4) return v4;
    // One IPv6 /64 is one client.
    return isIPv6(raw) ? expand6(raw).slice(0, 4).join(':') : raw;
  };
  // Separate budgets: challenge spam cannot block verification, and nothing can block revocation logouts.
  const linker = o.linkClient ?? o.client; const challenger = o.challengeClient ?? linker; const logouter = o.logoutClient ?? linker; const intents = o.intents ?? oneClick();
  const tooMany = (res: Response, rpcId?: string | number | null) => { res.status(429).set('Retry-After', '60'); return rpcId === undefined ? res.json({ error: 'rate_limit' }) : res.json({ jsonrpc: '2.0', id: rpcId, error: { code: -32002, message: 'Rate limit: retry after 60 seconds.' } }); };
  // Separate windows per kind, keyed by IP or token hash; when full, the oldest entries are evicted
  // so a flood of addresses can never lock out other clients.
  const windows = new Map<string, Map<string, { count: number; until: number }>>();
  const limited = (kind: string, key: string, max: number) => {
    const t = now(); let m = windows.get(kind); if (!m) windows.set(kind, m = new Map());
    let r = m.get(key); if (r && r.until <= t) { m.delete(key); r = undefined; }
    if (!r) { if (m.size >= 5000) for (const k of [...m.keys()].slice(0, 1000)) m.delete(k); r = { count: 0, until: t + 60000 }; m.set(key, r); }
    return ++r.count > max;
  };
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    // DNS-rebinding guard from the MCP transport spec: browsers may only call from our own origin.
    if (req.headers.origin && req.headers.origin !== o.origin) return void res.status(403).json({ error: 'origin' });
    if (req.method === 'POST' && !req.is('application/json')) return void res.status(415).json({ error: 'json_required' });
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  app.get('/mcp/api/health', (_req, res) => { res.json({ ok: true }); });
  // Agent challenges are issued through the module (the history server accepts them only from here),
  // so a signature can be checked locally before it spends the shared history-API budget.
  const challenges = new Map<string, Challenge>();
  app.post('/mcp/api/challenge', async (req, res) => {
    const cap = o.challengesPerMinute ?? { perIp: 2, total: 3 };
    if (limited('challenge', clientIp(req), cap.perIp) || limited('challenge-all', 'all', cap.total)) return void tooMany(res);
    const accountId = (req.body as { accountId?: unknown })?.accountId;
    if (!req.body || Object.keys(req.body).length !== 1 || typeof accountId !== 'string' || !/^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(accountId)) return void res.status(400).json({ error: 'invalid_account' });
    try {
      const c = await challenger.challenge(accountId); const t = now();
      for (const [id, v] of challenges) if (v.expiresAt <= t) challenges.delete(id);
      if (challenges.size >= 1000) challenges.delete(challenges.keys().next().value!);
      challenges.set(c.id, c); res.json(c);
    } catch (e) { res.status(e instanceof MainApiError && e.status < 500 ? e.status : 502).json({ error: e instanceof MainApiError ? e.code : 'challenge_failed' }); }
  });
  // Exchanges the user's NEP-413 signature (created on the /mcp page) for an agent token.
  app.post('/mcp/api/link', async (req, res) => {
    if (limited('link', clientIp(req), 6)) return void tooMany(res);
    // Reject junk before it can spend the shared history-API budget.
    if (!linkBody(req.body)) return void res.status(400).json({ error: 'invalid_verification' });
    const limits = parseLimits(req.body.limits); if (!limits) return void res.status(400).json({ error: 'invalid_limits' });
    try {
      const { challengeId, accountId, publicKey, signature } = req.body;
      // One attempt per challenge, as on the history server.
      const c = challenges.get(challengeId); challenges.delete(challengeId);
      if (!c || c.expiresAt <= now() || c.accountId !== accountId) return void res.status(401).json({ error: 'challenge_expired_or_used' });
      if (!verifySignature(c, publicKey, signature)) return void res.status(401).json({ error: 'invalid_signature' });
      const v = await linker.verify({ challengeId, accountId, publicKey, signature });
      // Only a grant whose signed text names the agent becomes a token.
      if (v.purpose !== 'agent') { await logouter.logout(v.session).catch(() => o.store.queueLogout(v.session)); return void res.status(400).json({ error: 'agent_grant_required' }); }
      const token = o.store.create(v.accountId, v.session, v.expiresAt, now(), limits);
      res.status(201).json({ token, accountId: v.accountId, expiresAt: v.expiresAt, limits });
    } catch (e) { res.status(e instanceof MainApiError && e.status < 500 ? e.status : 502).json({ error: e instanceof MainApiError ? e.code : 'link_failed' }); }
  });
  app.delete('/mcp/api/link', async (req, res) => {
    if (limited('revoke', clientIp(req), 20)) return void tooMany(res);
    const link = o.store.revoke(bearer(req)); if (!link) return void res.status(404).json({ error: 'unknown_token' });
    // ?all=1 also revokes every other token of the same account (for example a lost one).
    const sessions = [link.session, ...(req.query.all === '1' ? o.store.revokeAll(link.owner) : [])].filter(Boolean);
    // Tokens are already gone; answer now and end the history sessions in the background.
    res.json({ ok: true, revoked: sessions.length });
    void Promise.allSettled(sessions.map(s => logouter.logout(s).catch(() => o.store.queueLogout(s))));
  });

  // Retry logouts that failed earlier (busy budget or a restart of the history server).
  const retry = setInterval(() => {
    let due: string[] = []; try { due = o.store.takeLogouts(2); } catch { return; }
    for (const s of due) void logouter.logout(s).catch(() => { try { o.store.queueLogout(s); } catch { /* retried rows expire with the session */ } });
  }, 60000); retry.unref();
  // Exact `/mcp` is the JSON-RPC endpoint; `/mcp/` (trailing slash) is the onboarding page.
  const exact = (req: Request) => req.originalUrl.split('?')[0] === '/mcp';
  for (const method of ['get', 'delete', 'put', 'patch'] as const) app[method]('/mcp', (req, res, next) => { if (!exact(req)) return next(); res.set('Allow', 'POST').status(405).json({ error: 'use_post' }); });
  app.post('/mcp', async (req, res, next) => {
    if (!exact(req)) return next();
    const rpc = req.body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown } };
    const id = typeof rpc?.id === 'string' || typeof rpc?.id === 'number' ? rpc.id : null;
    const reply = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
    const error = (status: number, code: number, message: string) => res.status(status).json({ jsonrpc: '2.0', id, error: { code, message } });
    if (limited('rpc-ip', clientIp(req), 120)) return void tooMany(res, id);
    const token = bearer(req); const link = o.store.find(token, now());
    if (!link) return void res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Create an agent token at ' + o.origin + '/mcp/"').json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Missing or expired agent token. Create one at ' + o.origin + '/mcp/' } });
    if (limited('token', link.id, o.perTokenPerMinute ?? 10)) return void tooMany(res, id);
    // A JSON-RPC response sent by the client (no method) needs no reply.
    if (rpc && !Array.isArray(req.body) && rpc.jsonrpc === '2.0' && rpc.method === undefined && rpc.id !== undefined && ('result' in rpc || 'error' in rpc)) return void res.status(202).end();
    if (!rpc || Array.isArray(req.body) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || (rpc.id !== undefined && id === null)) return void error(400, -32600, 'Invalid JSON-RPC request.');
    const transport = req.headers['mcp-protocol-version'];
    if (transport !== undefined && !PROTOCOLS.includes(String(transport))) return void error(400, -32600, 'Unsupported MCP-Protocol-Version.');
    if (rpc.id === undefined) return void res.status(202).end(); // notification
    switch (rpc.method) {
      case 'initialize': {
        if (!rpc.params || typeof rpc.params !== 'object' || typeof rpc.params.protocolVersion !== 'string') return void error(200, -32602, 'initialize requires params.protocolVersion.');
        const asked = rpc.params.protocolVersion; const version = PROTOCOLS.includes(asked as string) ? asked : PROTOCOLS[0];
        return void reply({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nearverse', version: '0.1.0' },
          instructions: `NearVerse is a space exploration game on NEAR. Signed in as ${link.owner}. Systems and their chapters open only after a real swap: list_systems → get_swap_quote → sign and send the deposit with your own NEAR wallet tool → verify_arrival → start_expedition → complete_expedition. Spending limits: $${link.limits.perSwapUsd} per swap; $${link.limits.dailyUsd} per 24 hours for the whole account. Never send more than a quote asks for.` });
      }
      case 'ping': return void reply({});
      case 'tools/list': return void reply({ tools: toolDefinitions });
      case 'tools/call': {
        const name = rpc.params?.name; const args = rpc.params?.arguments ?? {};
        if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return void error(200, -32602, 'Invalid tool call.');
        if (!toolDefinitions.some(t => t.name === name)) return void error(200, -32602, `Unknown tool: ${name.slice(0, 60)}`);
        try {
          // One account may use at most 8 history calls a minute, so a single agent cannot take the whole shared budget.
          const client: MainClient = { ...o.client, call: (s, m, path, body) => limited('owner-main', link.owner, o.perOwnerMainPerMinute ?? 8) ? Promise.reject(new MainApiError(429, 'agent_budget_busy')) : o.client.call(s, m, path, body) };
          const result = await runTool(name, args as Record<string, unknown>, { client, link, store: o.store, intents, now });
          return void reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result, isError: false });
        } catch (e) {
          const text = e instanceof ToolError ? e.message : e instanceof OneClickError ? (e.code === 'intents_budget_busy' ? 'NEAR Intents requests are busy. Wait about a minute and call again; nothing was lost.' : `NEAR Intents refused: ${e.code}`) : e instanceof MainApiError ? (e.status === 401 ? 'Agent session expired. Create a new token at ' + o.origin + '/mcp/' : e.code === 'agent_budget_busy' ? 'NearVerse is busy with agent requests. Wait about a minute and call again; nothing was lost.' : `History service refused: ${e.code}`) : 'Internal error.';
          return void reply({ content: [{ type: 'text', text }], isError: true });
        }
      }
      default: return void error(200, -32601, 'Method not found.');
    }
  });

  // Same policy as the main site's wallet page (HOT connector executor needs inline script elements in its sandbox).
  const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; script-src-elem 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss:; frame-src https: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  if (o.staticDir && existsSync(o.staticDir)) app.use('/mcp', (_req, res, next) => { res.set('Content-Security-Policy', csp); next(); }, express.static(o.staticDir, { dotfiles: 'deny', index: 'index.html', setHeaders: (res, path) => res.setHeader('Cache-Control', path.endsWith('.html') ? 'no-store' : 'public, max-age=3600') }));
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  app.use((err: { status?: number }, req: Request, res: Response, _next: NextFunction) => {
    if (err.status === 400 && req.originalUrl.split('?')[0] === '/mcp') return void res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); res.status(err.status === 413 ? 413 : err.status === 400 ? 400 : 500).json({ error: err.status === 413 ? 'body_limit' : err.status === 400 ? 'invalid_json' : 'internal_error' }); });
  return app;
}
