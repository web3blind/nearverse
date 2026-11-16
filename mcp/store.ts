import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// The MCP module owns this database. It never opens the main history database.
export interface Limits { perSwapUsd: number; dailyUsd: number }
export interface Link { id: string; owner: string; session: string; expires: number; limits: Limits }
export interface QuoteRow { quoteId: string; systemId: string; originAsset: string; destinationAsset: string; depositAddress: string; amountIn: string; amountOut: string; minAmountOut: string; usdCents: number; createdAt: number; deadline: number; state: string }
export interface McpStore {
  create(owner: string, session: string, expires: number, now: number, limits?: Limits): string;
  find(token: string, now: number): Link | undefined;
  revoke(token: string): Link | undefined;
  /** Revokes every token of the account; returns their history sessions for logout. */
  revokeAll(owner: string): string[];
  /** History sessions whose logout failed; retried later so a revoked grant never stays alive. */
  queueLogout(session: string): void;
  takeLogouts(max: number): string[];
  /** Atomically checks the limits against the whole account's spending and records the quote; returns the refusal reason instead. */
  reserveQuote(link: Link, q: Omit<QuoteRow, 'quoteId' | 'state'>, now: number): QuoteRow | { refused: string };
  /** An unpaid, unexpired quote for the same destination, so an agent does not pay twice. */
  openQuote(link: Link, destinationAsset: string, now: number): QuoteRow | undefined;
  quote(link: Link, quoteId: string): QuoteRow | undefined;
  setQuoteState(link: Link, quoteId: string, state: string): void;
  spentCents(link: Link, now: number): number;
  close(): void;
}
export const DEFAULT_LIMITS: Limits = { perSwapUsd: 5, dailyUsd: 20 };
export const MAX_LIMIT_USD = 10000;
const DAY = 86400000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const tokenPattern = /^nvmcp_[A-Za-z0-9_-]{43}$/;
// Quotes that can no longer receive funds stop counting against the daily limit.
// EXPIRED is set only an hour after the deadline with no deposit seen; a late success can still mark it ARRIVED.
const RELEASED = ['EXPIRED', 'REFUNDED', 'FAILED'];

export function openMcpStore(path: string, secret: Buffer): McpStore {
  if (secret.length !== 32) throw new Error('MCP_SECRET must be 32 bytes (64 hex characters)');
  const db = new Database(path); db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, owner TEXT NOT NULL, session BLOB NOT NULL, expires INTEGER NOT NULL)');
  const columns = (db.prepare('PRAGMA table_info(links)').all() as { name: string }[]).map(c => c.name);
  if (!columns.includes('per_swap_cents')) db.exec(`ALTER TABLE links ADD COLUMN per_swap_cents INTEGER NOT NULL DEFAULT ${DEFAULT_LIMITS.perSwapUsd * 100}`);
  if (!columns.includes('daily_cents')) db.exec(`ALTER TABLE links ADD COLUMN daily_cents INTEGER NOT NULL DEFAULT ${DEFAULT_LIMITS.dailyUsd * 100}`);
  // An early build keyed quotes by token; such short-lived rows are dropped rather than migrated.
  const quoteCols = (db.prepare('PRAGMA table_info(quotes)').all() as { name: string }[]).map(c => c.name);
  if (quoteCols.length && !quoteCols.includes('owner')) db.exec('DROP TABLE quotes');
  db.exec(`CREATE TABLE IF NOT EXISTS quotes (quoteId TEXT PRIMARY KEY, owner TEXT NOT NULL, systemId TEXT NOT NULL, originAsset TEXT NOT NULL, destinationAsset TEXT NOT NULL,
    depositAddress TEXT NOT NULL, amountIn TEXT NOT NULL, amountOut TEXT NOT NULL, minAmountOut TEXT NOT NULL, usdCents INTEGER NOT NULL CHECK (usdCents > 0),
    createdAt INTEGER NOT NULL, deadline INTEGER NOT NULL, state TEXT NOT NULL)`);
  // Quotes belong to the account, not to one token: spending is summed across all tokens
  // (including revoked ones), and any valid token of the same account can finish a paid swap.
  db.exec('CREATE INDEX IF NOT EXISTS quotes_owner ON quotes(owner, createdAt)');
  db.exec('CREATE TABLE IF NOT EXISTS pending_logouts (id TEXT PRIMARY KEY, session BLOB NOT NULL, queuedAt INTEGER NOT NULL)');
  // The main-site session is a bearer credential; keep it encrypted at rest.
  // AAD binds each sealed session to its own token hash, so rows cannot be swapped.
  const seal = (plain: string, id: string) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', secret, iv); c.setAAD(Buffer.from(id)); const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); };
  const open = (blob: Buffer, id: string) => { const d = createDecipheriv('aes-256-gcm', secret, blob.subarray(0, 12)); d.setAAD(Buffer.from(id)); d.setAuthTag(blob.subarray(12, 28)); return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8'); };
  type Row = { owner: string; session: Buffer; expires: number; per_swap_cents: number; daily_cents: number };
  const toLink = (id: string, r: Row, session: string): Link => ({ id, owner: r.owner, session, expires: r.expires, limits: { perSwapUsd: r.per_swap_cents / 100, dailyUsd: r.daily_cents / 100 } });
  const spent = (owner: string, now: number) => (db.prepare(`SELECT COALESCE(SUM(usdCents),0) AS s FROM quotes WHERE owner=? AND createdAt>? AND state NOT IN (${RELEASED.map(() => '?').join(',')})`).get(owner, now - DAY, ...RELEASED) as { s: number }).s;
  return {
    create(owner, session, expires, now, limits = DEFAULT_LIMITS) {
      db.prepare('DELETE FROM links WHERE expires<=?').run(now);
      const token = 'nvmcp_' + randomBytes(32).toString('base64url'); const id = digest(token);
      db.prepare('INSERT INTO links (id,owner,session,expires,per_swap_cents,daily_cents) VALUES (?,?,?,?,?,?)').run(id, owner, seal(session, id), expires, Math.round(limits.perSwapUsd * 100), Math.round(limits.dailyUsd * 100));
      return token;
    },
    find(token, now) {
      if (!tokenPattern.test(token)) return undefined;
      const id = digest(token); const r = db.prepare('SELECT * FROM links WHERE id=?').get(id) as Row | undefined; if (!r || r.expires <= now) return undefined;
      // A changed MCP_SECRET or a damaged row behaves like an unknown token.
      try { return toLink(id, r, open(r.session, id)); }
      catch { db.prepare('DELETE FROM links WHERE id=?').run(id); return undefined; }
    },
    revoke(token) {
      if (!tokenPattern.test(token)) return undefined;
      const id = digest(token);
      const r = db.prepare('DELETE FROM links WHERE id=? RETURNING *').get(id) as Row | undefined;
      if (!r) return undefined;
      try { return toLink(id, r, open(r.session, id)); } catch { return toLink(id, r, ''); }
    },
    revokeAll(owner) {
      const rows = db.prepare('DELETE FROM links WHERE owner=? RETURNING id, session').all(owner) as { id: string; session: Buffer }[];
      return rows.flatMap(r => { try { return [open(r.session, r.id)]; } catch { return []; } });
    },
    queueLogout(session) { const id = 'logout:' + digest(session); db.prepare('INSERT OR IGNORE INTO pending_logouts VALUES (?,?,?)').run(id, seal(session, id), Date.now()); },
    takeLogouts(max) {
      // History sessions last at most 7 days; older rows are moot.
      db.prepare('DELETE FROM pending_logouts WHERE queuedAt<?').run(Date.now() - 7 * DAY);
      const rows = db.prepare('DELETE FROM pending_logouts WHERE id IN (SELECT id FROM pending_logouts ORDER BY queuedAt LIMIT ?) RETURNING id, session').all(max) as { id: string; session: Buffer }[];
      return rows.flatMap(r => { try { return [open(r.session, r.id)]; } catch { return []; } });
    },
    reserveQuote(link, q, now) {
      return db.transaction(() => {
        // Re-checked inside the write transaction: two parallel calls cannot both get a quote for one asset.
        if (db.prepare("SELECT 1 FROM quotes WHERE owner=? AND destinationAsset=? AND state='ISSUED' AND deadline>?").get(link.owner, q.destinationAsset, now)) return { refused: 'An unpaid quote for this asset is still valid. Use it or wait until it expires. Do not pay twice.' };
        if (q.usdCents > Math.round(link.limits.perSwapUsd * 100)) return { refused: `This swap is about $${(q.usdCents / 100).toFixed(2)}; the per-swap limit for this token is $${link.limits.perSwapUsd}.` };
        db.prepare('DELETE FROM quotes WHERE createdAt<?').run(now - 2 * DAY);
        if (!(q.usdCents > 0)) return { refused: 'No USD price for this swap.' };
        const used = spent(link.owner, now);
        if (used + q.usdCents > Math.round(link.limits.dailyUsd * 100)) return { refused: `Daily limit: $${(used / 100).toFixed(2)} of $${link.limits.dailyUsd} already reserved in the last 24 hours.` };
        const row: QuoteRow = { ...q, quoteId: 'q_' + randomBytes(12).toString('base64url'), state: 'ISSUED' };
        db.prepare('INSERT INTO quotes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.quoteId, link.owner, row.systemId, row.originAsset, row.destinationAsset, row.depositAddress, row.amountIn, row.amountOut, row.minAmountOut, row.usdCents, row.createdAt, row.deadline, row.state);
        return row;
      }).immediate();
    },
    openQuote(link, destinationAsset, now) { return db.prepare("SELECT quoteId,systemId,originAsset,destinationAsset,depositAddress,amountIn,amountOut,minAmountOut,usdCents,createdAt,deadline,state FROM quotes WHERE owner=? AND destinationAsset=? AND state='ISSUED' AND deadline>? ORDER BY createdAt DESC").get(link.owner, destinationAsset, now) as QuoteRow | undefined; },
    quote(link, quoteId) { return db.prepare('SELECT quoteId,systemId,originAsset,destinationAsset,depositAddress,amountIn,amountOut,minAmountOut,usdCents,createdAt,deadline,state FROM quotes WHERE owner=? AND quoteId=?').get(link.owner, quoteId) as QuoteRow | undefined; },
    // Only an unfinished quote changes state, so a slow call cannot undo ARRIVED and release spent budget.
    setQuoteState(link, quoteId, state) { db.prepare(`UPDATE quotes SET state=? WHERE owner=? AND quoteId=? AND state IN (${state === 'ARRIVED' ? "'ISSUED','EXPIRED'" : "'ISSUED'"})`).run(state, link.owner, quoteId); },
    spentCents(link, now) { return spent(link.owner, now); },
    close() { db.close(); },
  };
}
