import express, { type Request, type Response, type NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { bounded, digest, ownershipVerifier, token, verifySignature, type Challenge } from './auth';
import { openStore } from './store';
import { historySystems, homeSystemId } from './world';
import { verifyArrival, type ArrivalVerifier, type ArrivalProof } from './upstream';
import { isOpen, returnPending, routeAllowed, explorerLevel, RULES_V2_AT } from '../src/rules';
import { systems as worldSystems } from '../src/world';
import { released, seasonSource, SEASON_CHAPTER_SECONDS } from './seasons';

export interface HistorySystem { id: string; assetId: string; stories: { id: string; durationMs: number; requires?: string[] }[] }
export interface AppOptions {
  origin: string; db?: Database.Database; now?: () => number; secureCookies?: boolean;
  systems?: HistorySystem[]; homeSystemId?: string;
  /** Shared with the MCP module only; without it, agent grants are disabled. */
  agentLinkSecret?: string;
  /** Runtime JSON with seasonal chapters (see server/seasons.ts). */
  seasonsFile?: string;
  verifyOwnership?: (owner: string, publicKey: string) => Promise<boolean>;
  verifyArrival?: ArrivalVerifier;
}
interface EventRow { seq: number; eventId: string; type: string; systemId: string; storyId: string | null; createdAt: number; payload: string; fingerprint: string }
const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
}
function fail(res: Response, status: number, error: string) { res.status(status).json({ error }); }
function wire(row: EventRow) { return { seq: row.seq, eventId: row.eventId, type: row.type, systemId: row.systemId, ...(row.storyId ? { storyId: row.storyId } : {}), createdAt: row.createdAt, ...JSON.parse(row.payload) }; }
export function createApp(options: AppOptions) {
  const origin = new URL(options.origin).origin;
  if (origin !== options.origin) throw new Error('origin_must_be_canonical');
  const secure = options.secureCookies ?? origin.startsWith('https:');
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('https_required');
  const db = options.db ?? openStore(); const now = options.now ?? Date.now;
  const owns = options.verifyOwnership ?? ownershipVerifier(); const arrives = options.verifyArrival ?? verifyArrival;
  const baseSystems = options.systems ?? historySystems; const season = seasonSource(options.seasonsFile, db);
  // Static chapters plus seasonal chapters released by now; each seasonal chapter follows the previous one.
  const systemsNow = (owner?: string): HistorySystem[] => { const used = owner ? new Set(rows(owner).map(e => e.storyId)) : new Set(); const out = season().filter(c => Date.parse(c.releaseAt) <= now() || used.has(c.id)); return baseSystems.map(s => { const extra = out.filter(c => c.systemId === s.id); if (!extra.length) return s; const stories = [...s.stories]; for (const c of extra) stories.push({ id: c.id, durationMs: SEASON_CHAPTER_SECONDS * 1000, requires: [stories[stories.length - 1].id] }); return { ...s, stories }; }); }; const home = options.homeSystemId ?? homeSystemId; const app = express(); app.disable('x-powered-by');
  const rates = new Map<string, { count: number; until: number }>();
  const linkSecret = options.agentLinkSecret && options.agentLinkSecret.length >= 32 ? Buffer.from(options.agentLinkSecret) : undefined;
  const agentLink = (req: Request) => {
    const given = req.headers['x-nearverse-agent-link'];
    return !!linkSecret && typeof given === 'string' && given.length === linkSecret.length && timingSafeEqual(Buffer.from(given), linkSecret);
  };
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    const time = now();
    for (const [key, value] of rates) if (value.until <= time) rates.delete(key);
    const key = req.ip || 'unknown'; const rate = rates.get(key) ?? { count: 0, until: time + 60000 };
    if (rates.size >= 10000 && !rates.has(key)) return fail(res, 429, 'rate_limit');
    rates.set(key, rate); if (++rate.count > 120) return fail(res, 429, 'rate_limit');
    if (req.headers.origin && req.headers.origin !== origin) return fail(res, 403, 'origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'origin');
      if (!req.is('application/json')) return fail(res, 415, 'json_required');
    }
    db.prepare('DELETE FROM challenges WHERE expires <= ?').run(time);
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(time);
    next();
  });
  app.use(express.json({ limit: '8kb', strict: true }));
  const cookieName = secure ? '__Host-nearverse' : 'nearverse';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict' as const, path: '/' };
  function session(req: Request) {
    const entries = (req.headers.cookie || '').split(';').map(s => s.trim().split('='));
    const raw = entries.find(([name]) => name === cookieName)?.[1];
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
    return db.prepare('SELECT owner,expires FROM sessions WHERE id=? AND expires>?').get(digest(raw), now()) as { owner: string; expires: number } | undefined;
  }
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const value = session(req); if (!value) return fail(res, 401, 'authentication_required');
    if (req.headers['x-nearverse-account'] !== undefined && req.headers['x-nearverse-account'] !== value.owner) return fail(res, 409, 'account_changed');
    res.locals.owner = value.owner; next();
  };
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.post('/api/auth/challenge', (req, res) => {
    if (!exact(req.body, ['accountId', 'purpose']) || typeof req.body.accountId !== 'string' || !accountPattern.test(req.body.accountId)) return fail(res, 400, 'invalid_account');
    // An agent grant is stated in the signed text and lasts longer than a browser sign-in.
    if (req.body.purpose !== undefined && req.body.purpose !== 'agent') return fail(res, 400, 'invalid_purpose');
    const agent = req.body.purpose === 'agent';
    // Only the MCP module may request a 7-day agent grant, so a browser never gets a 7-day cookie.
    if (agent && !agentLink(req)) return fail(res, 403, 'agent_link_only');
    if ((db.prepare('SELECT count(*) AS n FROM challenges').get() as { n: number }).n >= 1000) return fail(res, 429, 'challenge_limit');
    const expiresAt = now() + 5 * 60000; const id = token();
    const challenge: Challenge = { id, accountId: req.body.accountId, recipient: new URL(origin).host, nonce: randomBytes(32).toString('base64'), expiresAt, ...(agent ? { purpose: 'agent' as const } : {}),
      message: `${agent ? `Grant an AI agent access to your NearVerse journal for 7 days. Sign only on ${origin}/mcp/. No transaction or transfer.` : 'Sign in to NearVerse history. No transaction or transfer.'}\nAccount: ${req.body.accountId}\nOrigin: ${origin}\nChallenge: ${id}\nExpires: ${new Date(expiresAt).toISOString()}` };
    db.prepare('INSERT INTO challenges VALUES (?,?,?)').run(id, JSON.stringify(challenge), expiresAt); res.json(challenge);
  });
  app.post('/api/auth/verify', async (req, res) => {
    if (!exact(req.body, ['challengeId', 'accountId', 'publicKey', 'signature']) || !['challengeId','accountId','publicKey','signature'].every(k => typeof req.body[k] === 'string' && req.body[k].length <= 200)) return fail(res, 400, 'invalid_verification');
    // Atomic consumption precedes network I/O: concurrent replays cannot create sessions.
    const row = db.prepare('DELETE FROM challenges WHERE id=? RETURNING value,expires').get(req.body.challengeId) as { value: string; expires: number } | undefined;
    if (!row || row.expires <= now()) return fail(res, 401, 'challenge_expired_or_used');
    const challenge = JSON.parse(row.value) as Challenge;
    if (challenge.purpose === 'agent' && !agentLink(req)) return fail(res, 403, 'agent_link_only');
    const publicKey = req.body.publicKey as string; const signature = req.body.signature as string;
    if (req.body.accountId !== challenge.accountId || !verifySignature(challenge, publicKey, signature)) return fail(res, 401, 'invalid_signature');
    try { if (!await bounded(owns(challenge.accountId, publicKey))) return fail(res, 401, 'ownership'); }
    catch { return fail(res, 503, 'ownership_unavailable'); }
    if (challenge.expiresAt <= now()) return fail(res, 401, 'challenge_expired_or_used');
    const raw = token(); const expiresAt = now() + (challenge.purpose === 'agent' ? 7 : 1) * 24 * 60 * 60000;
    const previous = (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([name]) => name === cookieName)?.[1];
    if (previous) db.prepare('DELETE FROM sessions WHERE id=?').run(digest(previous));
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(raw), challenge.accountId, expiresAt);
    res.cookie(cookieName, raw, { ...cookieOptions, maxAge: expiresAt - now() }); res.json({ accountId: challenge.accountId, expiresAt, purpose: challenge.purpose ?? 'site' });
  });
  app.get('/api/auth/session', (req, res) => { const value = session(req); res.json(value ? { accountId: value.owner, expiresAt: value.expires } : { accountId: null }); });
  app.post('/api/auth/logout', (req, res) => {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([name]) => name === cookieName)?.[1];
    if (raw) db.prepare('DELETE FROM sessions WHERE id=?').run(digest(raw));
    res.clearCookie(cookieName, cookieOptions); res.json({ ok: true });
  });
  const revision = (owner:string) => (db.prepare('SELECT revision FROM journal_revisions WHERE owner=?').get(owner) as {revision:number}|undefined)?.revision ?? 0;
  const rows = (owner: string) => db.prepare('SELECT * FROM events WHERE owner=? ORDER BY seq').all(owner) as EventRow[];
  app.get('/api/events', auth, (_req, res) => { res.json({ events: rows(res.locals.owner).map(wire) }); });
  app.get('/api/journal', auth, (_req, res) => { res.set('Content-Disposition', 'attachment; filename="nearverse-journal.json"'); res.json({ version: 1, accountId: res.locals.owner, events: rows(res.locals.owner).map(wire) }); });
  app.delete('/api/journal', auth, (req, res) => {
    if (!exact(req.body, []) ) return fail(res, 400, 'invalid_delete');
    db.transaction(()=>{
      db.prepare('INSERT INTO journal_revisions(owner,revision) VALUES (?,1) ON CONFLICT(owner) DO UPDATE SET revision=revision+1').run(res.locals.owner);
      db.prepare('DELETE FROM events WHERE owner=?').run(res.locals.owner);
    })();res.json({ ok: true });
  });
  // Ship profile: name, biography and built-in art. Stored per account so it follows the player across devices.
  const shipRow = (owner: string) => db.prepare('SELECT name,biography,art,updatedAt FROM ships WHERE owner=?').get(owner) as { name: string; biography: string; art: string; updatedAt: number } | undefined;
  app.get('/api/ship', auth, (_req, res) => {
    const level = explorerLevel(rows(res.locals.owner).map(e => ({ type: e.type, systemId: e.systemId, storyId: e.storyId, createdAt: e.createdAt })));
    res.json({ ship: shipRow(res.locals.owner) ?? null, level });
  });
  app.put('/api/ship', auth, (req, res) => {
    const body = req.body;
    if (!validShip(body)) return fail(res, 400, 'invalid_ship');
    db.prepare('INSERT INTO ships(owner,name,biography,art,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET name=excluded.name,biography=excluded.biography,art=excluded.art,updatedAt=excluded.updatedAt').run(res.locals.owner, body.name, body.biography, body.art, now());
    res.json({ ship: shipRow(res.locals.owner) });
  });
  // Seasonal chapters for systems this account has reached: titles for reached systems, texts only once read.
  app.get('/api/season', auth, (_req, res) => {
    const history = rows(res.locals.owner).map(e => ({ type: e.type, systemId: e.systemId, storyId: e.storyId, createdAt: e.createdAt }));
    const used = new Set(history.map(e => e.storyId));
    res.json({ chapters: season().filter(c => Date.parse(c.releaseAt) <= now() || used.has(c.id)).filter(c => { const w = worldSystems.find(s => s.id === c.systemId); return !!w && isOpen(w, history); })
      .map(c => ({ id: c.id, systemId: c.systemId, title: c.title, durationSeconds: SEASON_CHAPTER_SECONDS, releaseAt: c.releaseAt, ...(history.some(e => e.type === 'story.read' && e.storyId === c.id) ? { text: c.text } : {}) })) });
  });
  app.post('/api/events', auth, async (req, res) => {
    const body = req.body;
    if (!exact(body, ['eventId','type','systemId','storyId','proof']) || !['eventId','systemId'].every(k => typeof body[k] === 'string' && identifier.test(body[k] as string)) || !['arrival','expedition.started','expedition.completed','story.read'].includes(body.type as string)) return fail(res, 400, 'invalid_event');
    const systems = systemsNow(res.locals.owner as string); const system = systems.find(s => s.id === body.systemId); if (!system) return fail(res, 400, 'unknown_system');
    if (body.type !== 'arrival' && ('proof' in body || typeof body.storyId !== 'string')) return fail(res, 400, 'invalid_event');
    if (body.type === 'arrival' && ('storyId' in body || !validProof(body.proof))) return fail(res, 400, 'invalid_proof');
    const fingerprint = digest(JSON.stringify([body.type, body.systemId, body.storyId ?? null, body.proof ? Object.entries(body.proof).sort(([a],[b]) => a.localeCompare(b)) : null]));
    const owner = res.locals.owner as string;const journalRevision = revision(owner);
    const existing = () => db.prepare('SELECT * FROM events WHERE owner=? AND eventId=?').get(owner, body.eventId) as EventRow | undefined;
    const prior = existing();
    if (prior) return prior.fingerprint === fingerprint ? res.json({ event: wire(prior) }) : fail(res, 409, 'event_id_conflict');
    if (body.type === 'arrival') {
      // One swap opens one system, and only along its route (source asset → system asset).
      // A swap quoted before the rule change still counts, so nobody who paid earlier gets stuck.
      const offRoute = worldSystems.some(s => s.id === system.id) && !routeAllowed(system.id, (body.proof as ArrivalProof)?.originAsset);
      try { const verdict = await bounded(arrives(owner, { systemId: system.id, assetId: system.assetId }, body.proof as unknown as ArrivalProof, offRoute ? { quotedBefore: RULES_V2_AT } : undefined)); if (verdict !== true) return fail(res, 409, verdict === 'route_mismatch' ? 'route_mismatch' : 'arrival_unverified'); }
      catch { return fail(res, 503, 'arrival_verification_unavailable'); }
    }
    // Logout/expiry during an upstream await must revoke the in-flight write too.
    if (session(req)?.owner !== owner) return fail(res, 401, 'authentication_required');
    if(revision(owner) !== journalRevision) return fail(res,409,'journal_deleted');
    // Network awaits are outside the SQLite transaction; all ordering is rechecked inside.
    try {
      const result = db.transaction(() => {
        const duplicate = existing(); if (duplicate) { if (duplicate.fingerprint !== fingerprint) throw new Error('event_id_conflict'); return duplicate; }
        const history = rows(owner); if (history.length >= 10000) throw new Error('journal_limit');
        const world = worldSystems.find(s => s.id === system.id);
        const ruleHistory = history.map(e => ({ type: e.type, systemId: e.systemId, storyId: e.storyId, createdAt: e.createdAt }));
        const visited = (!!home && system.assetId === systems.find(s => s.id === home)?.assetId) || (world ? isOpen(world, ruleHistory) : history.some(e => e.type === 'arrival' && e.systemId === system.id));
        const story = system.stories.find(s => s.id === body.storyId);
        if (body.type === 'expedition.started' && world && story && returnPending(world, system.stories.indexOf(story), ruleHistory)) throw new Error('return_required');
        const relevant = history.filter(e => e.systemId === system.id && e.storyId === body.storyId);
        let payload = '{}';
        if (body.type !== 'arrival') {
          if (!visited || !story) throw new Error('exploration_locked');
          if (body.type === 'expedition.started') {
            if (relevant.length || !(story.requires ?? []).every(id => history.some(e => e.type === 'story.read' && e.storyId === id))) throw new Error('story_order');
            if (history.some(e => e.type === 'expedition.started' && !history.some(c => c.type === 'expedition.completed' && c.systemId === e.systemId && c.storyId === e.storyId))) throw new Error('expedition_active');
            payload = JSON.stringify({ readyAt: now() + story.durationMs });
          } else if (body.type === 'expedition.completed') {
            const start = relevant.find(e => e.type === 'expedition.started');
            if (!start || relevant.some(e => e.type === body.type) || now() < JSON.parse(start.payload).readyAt) throw new Error('expedition_not_ready');
          } else if (!relevant.some(e => e.type === 'expedition.completed') || relevant.some(e => e.type === 'story.read')) throw new Error('story_order');
        }
        const operation = body.type === 'arrival' ? digest(JSON.stringify([(body.proof as ArrivalProof).depositAddress, (body.proof as ArrivalProof).depositMemo ?? ''])) : null;
        db.prepare('INSERT INTO events(owner,eventId,type,systemId,storyId,createdAt,payload,fingerprint,operation) VALUES (?,?,?,?,?,?,?,?,?)').run(owner, body.eventId, body.type, system.id, body.storyId ?? null, now(), payload, fingerprint, operation);
        return existing()!;
      })();
      res.status(201).json({ event: wire(result) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      fail(res, 409, ['journal_limit','event_id_conflict','exploration_locked','story_order','expedition_active','expedition_not_ready','return_required'].includes(message) ? message : 'event_conflict');
    }
  });
  app.use((_req, res) => { fail(res, 404, 'not_found'); });
  app.use((error: { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => { fail(res, error.status === 413 ? 413 : error.status === 400 ? 400 : 500, error.status === 413 ? 'body_limit' : error.status === 400 ? 'invalid_json' : 'internal_error'); });
  return app;
}
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export function validShip(value: unknown): value is { name: string; biography: string; art: string } {
  return exact(value, ['name','biography','art']) && Object.keys(value).length === 3
    && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 60 && !controls.test(value.name) && !/[\r\n\t]/.test(value.name)
    && typeof value.biography === 'string' && value.biography.length <= 2000 && !controls.test(value.biography)
    && ['courier','surveyor','sail'].includes(value.art as string);
}
function validProof(value: unknown): boolean {
  if (!exact(value, ['depositAddress','depositMemo','originAsset','destinationAsset','amountIn','amountOut','minAmountOut'])) return false;
  return typeof value.depositAddress === 'string' && /^[a-zA-Z0-9._:-]{2,200}$/.test(value.depositAddress)
    && (value.depositMemo === undefined || typeof value.depositMemo === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(value.depositMemo))
    && ['originAsset','destinationAsset'].every(k => typeof value[k] === 'string' && (value[k] as string).length > 0 && (value[k] as string).length <= 200)
    && ['amountIn','amountOut','minAmountOut'].every(k => typeof value[k] === 'string' && /^[1-9][0-9]{0,77}$/.test(value[k] as string));
}
