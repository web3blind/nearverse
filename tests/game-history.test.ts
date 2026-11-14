import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../server/app';
import { openStore } from '../server/store';
import { digest } from '../server/auth';
import { createGameStorage, type GameSave, type Scope } from '../src/storage';
import { historyTransport } from '../src/App';
vi.mock('../src/sdk/FinancialPanel', () => ({ FinancialPanel: () => null }));
const account: Scope = { mode: 'real', account: 'alice.near' };
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined; }
});
async function setup() {
  const db = openStore(); let time = 100000;
  const sessionToken = 'a'.repeat(43);
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(sessionToken), 'alice.near', time + 1000000);
  // A pre-created session is an explicit test fixture. No real wallet, signature, RPC or swap.
  const app = createApp({ origin: 'http://127.0.0.1', db, now: () => time });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen');
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (path: string, init: RequestInit = {}) => nativeFetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { ...init.headers as Record<string, string>, Origin: 'http://127.0.0.1', Cookie: `nearverse=${sessionToken}` } }));
  const data = new Map<string, GameSave>();
  const store = createGameStorage({ async get(key) { return structuredClone(data.get(key)); }, async set(key, value) { data.set(key, structuredClone(value)); } });
  return { store, db, setTime(value: number) { time = value; } };
}
describe('game cache → actual HTTP history API → SQLite (controlled authenticated session)', () => {
  it('starts at home without swap, uses server time, completes and reads in order', async () => {
    const { store, db, setTime } = await setup();
    try {
      const empty = await store.sync(account, historyTransport);
      expect(empty.events).toEqual([]);
      await store.append(account, { eventId: 'start-1', type: 'expedition.started', systemId: 'near-lada', storyId: 'lada-1', createdAt: 1 });
      const started = await store.sync(account, historyTransport);
      expect(started.queue).toEqual([]);
      expect(started.events[0]).toMatchObject({ createdAt: 100000, readyAt: 115000 });
      setTime(115000);
      await store.append(account, { eventId: 'complete-1', type: 'expedition.completed', systemId: 'near-lada', storyId: 'lada-1', createdAt: 2 });
      await store.sync(account, historyTransport);
      await store.append(account, { eventId: 'read-1', type: 'story.read', systemId: 'near-lada', storyId: 'lada-1', createdAt: 3 });
      const complete = await store.sync(account, historyTransport);
      expect(complete.queue).toEqual([]);
      expect(complete.events.map(event => event.type)).toEqual(['expedition.started', 'expedition.completed', 'story.read']);
      expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 3 });
      await store.sync(account, historyTransport);
      expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });
  it('does not trust the local completion timer and retains a rejected completion for retry', async () => {
    const { store, db, setTime } = await setup();
    try {
      await store.append(account, { eventId: 'start', type: 'expedition.started', systemId: 'near-lada', storyId: 'lada-1', createdAt: 0 });
      await store.sync(account, historyTransport);
      await store.append(account, { eventId: 'finish', type: 'expedition.completed', systemId: 'near-lada', storyId: 'lada-1', createdAt: 999999999 });
      await expect(store.sync(account, historyTransport)).rejects.toThrow('HTTP 409');
      expect((await store.load(account)).queue).toEqual(['finish']);
      setTime(115000);
      expect((await store.sync(account, historyTransport)).queue).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='expedition.completed'").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
  it('rejects a different account session and leaves expiry failures unsynced', async () => {
    const { store, db, setTime } = await setup();
    try {
      await expect(historyTransport.read('bob.near')).rejects.toThrow('another account');
      await store.append(account, { eventId: 'waiting', type: 'expedition.started', systemId: 'near-lada', storyId: 'lada-1', createdAt: 0 });
      setTime(2000000);
      await expect(store.sync(account, historyTransport)).rejects.toThrow('separate sign-in');
      expect((await store.load(account)).queue).toEqual(['waiting']);
      expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
