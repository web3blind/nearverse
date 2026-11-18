// Loopback client for the existing history API. The module uses only the
// public HTTP contract, so every existing check (signatures, ownership,
// story order, arrival verification) still applies to agents.
import type { Challenge } from '../server/auth';
export class MainApiError extends Error { constructor(public status: number, public code: string) { super(code); } }
export interface MainClient {
  challenge(accountId: string): Promise<Challenge>;
  verify(body: unknown): Promise<{ session: string; accountId: string; expiresAt: number; purpose: string }>;
  call(session: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown>;
  logout(session: string): Promise<void>;
}
export function mainClient(base: string, origin: string, perMinute = 20, timeoutMs = 8000, agentLinkSecret = ''): MainClient {
  // Behind nginx the main API rate-limits every client under one loopback key;
  // a total budget keeps agents from starving human visitors.
  const cookieName = origin.startsWith('https:') ? '__Host-nearverse' : 'nearverse';
  let window = 0; let used = 0;
  async function send(method: string, path: string, session?: string, body?: unknown) {
    const now = Date.now(); if (now - window >= 60000) { window = now; used = 0; }
    if (++used > perMinute) throw new MainApiError(429, 'agent_budget_busy');
    const headers: Record<string, string> = { Origin: origin, Accept: 'application/json' };
    if (session) headers.Cookie = `${cookieName}=${session}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (agentLinkSecret && path.startsWith('/api/auth/')) headers['X-NearVerse-Agent-Link'] = agentLinkSecret;
    let res: Response;
    try { res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
    catch { throw new MainApiError(503, 'history_unavailable'); }
    const text = await res.text(); if (text.length > 2_000_000) throw new MainApiError(502, 'history_response_too_large');
    let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { throw new MainApiError(502, 'history_invalid_response'); }
    if (!res.ok) throw new MainApiError(res.status, typeof (data as { error?: unknown })?.error === 'string' ? (data as { error: string }).error : 'history_error');
    return { res, data };
  }
  return {
    async challenge(accountId) {
      const { data } = await send('POST', '/api/auth/challenge', undefined, { accountId, purpose: 'agent' });
      const c = data as Challenge;
      if (!c || typeof c.id !== 'string' || c.accountId !== accountId || c.purpose !== 'agent' || typeof c.message !== 'string' || typeof c.nonce !== 'string' || typeof c.recipient !== 'string' || typeof c.expiresAt !== 'number') throw new MainApiError(502, 'history_invalid_response');
      return c;
    },
    async verify(body) {
      const { res, data } = await send('POST', '/api/auth/verify', undefined, body);
      const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith(cookieName + '='));
      const session = cookie?.slice(cookieName.length + 1); const d = data as { accountId?: unknown; expiresAt?: unknown; purpose?: unknown };
      if (!session || !/^[A-Za-z0-9_-]{43}$/.test(session) || typeof d.accountId !== 'string' || typeof d.expiresAt !== 'number') throw new MainApiError(502, 'history_invalid_response');
      return { session, accountId: d.accountId, expiresAt: d.expiresAt, purpose: typeof d.purpose === 'string' ? d.purpose : 'site' };
    },
    async call(session, method, path, body) { return (await send(method, path, session, body)).data; },
    async logout(session) { await send('POST', '/api/auth/logout', session, {}); },
  };
}
