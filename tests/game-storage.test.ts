import { describe, it, expect } from 'vitest';
import { createGameStorage, emptySave, validateSave, validateSequence, MAX_EXPORT_BYTES, type Cache, type GameEvent, type GameSave, type Scope } from '../src/storage';
import { regions, systems, validateWorld } from '../src/world';

function memory() {
  const values = new Map<string, GameSave>();
  const cache: Cache = { async get(key) { return structuredClone(values.get(key)); }, async set(key, value) { values.set(key, structuredClone(value)); } };
  return { cache, store: createGameStorage(cache) };
}
const preview: Scope = { mode: 'preview', account: null };
const alice: Scope = { mode: 'real', account: 'alice.near' };
function event(id: string, type: GameEvent['type'], storyId?: string, systemId = 'near-lada'): GameEvent {
  return { eventId: id, type, systemId, ...(storyId ? { storyId } : {}), createdAt: 1000 };
}
describe('world canon and progressive exploration', () => {
  it('preserves the eight original systems and adds agreed energy with unique sequential chapters', () => {
    expect(() => validateWorld()).not.toThrow();
    expect(regions.map(region => region.asset)).toEqual(['NEAR', 'BTC', 'ETH', 'USDT', 'USDC', 'SOL']);
    for (const region of regions) expect(systems.filter(system => system.asset === region.asset)).toHaveLength(['USDC','SOL'].includes(region.asset)?1:2);
    expect(new Set(systems.flatMap(system => system.stories.map(story => story.id))).size).toBe(30);
  });
  it('rejects starting a later chapter and completing an expedition that never started', () => {
    expect(() => validateSequence([event('a', 'expedition.started', 'lada-2')])).toThrow();
    expect(() => validateSequence([event('a', 'expedition.completed', 'lada-1')])).toThrow();
    expect(() => validateSequence([event('a', 'story.read', 'lada-1')])).toThrow();
  });
  it('unlocks every system in an arrived region without forcing additional swaps', () => {
    // No free home system: even NEAR systems need a verified arrival.
    expect(() => validateSequence([event('a', 'expedition.started', 'lada-1')])).toThrow();
    expect(() => validateSequence([event('x', 'arrival'), event('a', 'expedition.started', 'echo-1', 'near-echo')])).not.toThrow();
    expect(() => validateSequence([event('a', 'expedition.started', 'basalt-1', 'btc-basalt')])).toThrow();
    expect(() => validateSequence([event('a', 'arrival', undefined, 'btc-basalt'), event('b', 'expedition.started', 'ember-1', 'btc-ember')])).not.toThrow();
  });
});
// The server journal is the only source of real arrivals.
const ARR = event('arr', 'arrival');
const seed = (store: ReturnType<typeof createGameStorage>) => store.sync(alice, { async read() { return [ARR]; }, async append(): Promise<GameEvent> { throw new Error('nothing queued'); } });
describe('account-isolated local cache and durable queue', () => {
  it('drops a pre-swap-only real cache (free Lada chapters) but keeps the ship', async () => {
    const { store, cache } = memory();
    const legacy = { ...emptySave(alice), ship: { name: 'Old ship', biography: '', art: 'sail' as const }, events: [event('old', 'expedition.started', 'lada-1')], queue: ['old'] };
    await cache.set('real:alice.near', legacy);
    const save = await store.load(alice);
    expect(save.events).toEqual([]); expect(save.queue).toEqual([]); expect(save.ship.name).toBe('Old ship');
  });
  it('persists ship and active expedition when a repository is reconstructed', async () => {
    const { cache, store } = memory();
    await store.saveShip(preview, { name: 'Память', biography: 'Биография', art: 'sail' });
    await store.append(preview, event('v', 'visit')); await store.append(preview, event('start', 'expedition.started', 'lada-1'));
    const restored = await createGameStorage(cache).load(preview);
    expect(restored.ship.name).toBe('Память');
    expect(restored.events[1].createdAt).toBe(1000);
    expect(restored.queue).toEqual([]);
  });
  it('keeps preview, guest and both real owners separate', async () => {
    const { store } = memory();
    await store.append(preview, event('demo', 'visit', undefined, 'btc-basalt'));
    await seed(store); await store.append(alice, event('alice-start', 'expedition.started', 'lada-1'));
    expect((await store.load({ mode: 'real', account: 'bob.near' })).events).toEqual([]);
    expect((await store.load({ mode: 'real', account: null })).events).toEqual([]);
    expect((await store.load(alice)).queue).toEqual(['alice-start']);
    expect((await store.load(preview)).events).toHaveLength(1);
  });
  it('serializes concurrent modifications without losing ship or queue', async () => {
    const { store } = memory(); await seed(store);
    await Promise.all([
      store.saveShip(alice, { name: 'Полярник', biography: '', art: 'surveyor' }),
      store.append(alice, event('a', 'expedition.started', 'lada-1')),
    ]);
    const save = await store.load(alice);
    expect(save.ship.name).toBe('Полярник');
    expect(save.queue).toEqual(['a']);
  });
  it('deduplicates identical retries but rejects reuse with a different payload', async () => {
    const { store } = memory(); const start = event('a', 'expedition.started', 'lada-1'); await seed(store);
    await store.append(alice, start); await store.append(alice, start);
    expect((await store.load(alice)).events).toHaveLength(2);
    await expect(store.append(alice, { ...start, createdAt: 1234 })).rejects.toThrow('already in use');
  });
  it('never accepts client-side arrivals in real mode', async () => {
    const { store } = memory();
    await expect(store.append(alice, event('a', 'arrival', undefined, 'btc-basalt'))).rejects.toThrow('Only the server');
    await expect(store.append(alice, event('a', 'visit', undefined, 'btc-basalt'))).rejects.toThrow('Only the server');
  });
  it('preserves unsynced events after failure and safely retries with the same identifier', async () => {
    const { store } = memory(); const start = event('start', 'expedition.started', 'lada-1'); await seed(store);
    await store.append(alice, start);
    await expect(store.sync(alice, { async read() { return [ARR]; }, async append() { throw new Error('offline'); } })).rejects.toThrow('offline');
    expect((await store.load(alice)).queue).toEqual(['start']);
    const received: string[] = [];
    const save = await store.sync(alice, { async read() { return [ARR]; }, async append(account, input) { expect(account).toBe('alice.near'); received.push(input.eventId); return { ...input, createdAt: 2000, readyAt: 17000 }; } });
    expect(received).toEqual(['start']); expect(save.queue).toEqual([]); expect(save.events.find(e => e.eventId === 'start')!.readyAt).toBe(17000);
  });
  it('hydrates the server journal and acknowledges an already persisted event without reposting', async () => {
    const { store } = memory(); const start = event('a', 'expedition.started', 'lada-1'); await seed(store);
    await store.append(alice, start);
    const save = await store.sync(alice, { async read() { return [ARR, { ...start, createdAt: 3000, readyAt: 18000 }]; }, async append() { throw new Error('must not repost'); } });
    expect(save.events).toHaveLength(2); expect(save.events[1].createdAt).toBe(3000); expect(save.queue).toEqual([]);
  });
  it('rejects a mismatched acknowledgement without clearing the queue', async () => {
    const { store } = memory(); await seed(store); await store.append(alice, event('a', 'expedition.started', 'lada-1'));
    await expect(store.sync(alice, { async read() { return [ARR]; }, async append() { return event('other', 'expedition.started', 'lada-1'); } })).rejects.toThrow('different event');
    expect((await store.load(alice)).queue).toEqual(['a']);
  });
  it('cannot send preview or guest state to a server', async () => {
    const { store } = memory(); const transport = { async read() { throw new Error('contacted'); }, async append(): Promise<GameEvent> { throw new Error('contacted'); } };
    await expect(store.sync(preview, transport)).rejects.toThrow('cannot be synced');
    await expect(store.sync({ mode: 'real', account: null }, transport)).rejects.toThrow('cannot be synced');
  });
});
describe('bounded plain-data import/export', () => {
  it('roundtrips preview with plain text but never preserves arbitrary uploaded art or extra keys', async () => {
    const { store } = memory(); const save = emptySave(preview);
    save.ship.biography = '<script>alert(1)</script>';
    const imported = await store.import(preview, JSON.stringify({ ...save, privateKey: 'not accepted' }));
    expect(imported.ship.biography).toContain('<script>');
    expect(await store.export(preview)).not.toContain('privateKey');
    expect(JSON.parse(await store.export(preview)).scope).toEqual(preview);
    await expect(store.import(preview, JSON.stringify({ ...save, ship: { ...save.ship, art: 'https://evil.test/a.svg' } }))).rejects.toThrow();
  });
  it('refuses malformed, oversized, foreign-account and cross-mode imports', async () => {
    const { store } = memory();
    await expect(store.import(preview, '{')).rejects.toThrow();
    await expect(store.import(preview, 'x'.repeat(MAX_EXPORT_BYTES + 1))).rejects.toThrow('512');
    await expect(store.import(alice, JSON.stringify(emptySave(preview)))).rejects.toThrow('different account or mode');
    await expect(store.import(alice, JSON.stringify(emptySave({ mode: 'real', account: 'bob.near' })))).rejects.toThrow('different account or mode');
  });
  it('imports only real ship settings, never forged arrival claims', async () => {
    const { store } = memory(); const forged = emptySave(alice);
    forged.ship.name = 'Импортирован'; forged.events = [event('forged', 'arrival', undefined, 'btc-basalt')];
    const save = await store.import(alice, JSON.stringify(forged));
    expect(save.ship.name).toBe('Импортирован'); expect(save.events).toEqual([]);
  });
  it('rejects invalid story references, timestamps, versions, duplicate ids and oversized text', () => {
    const save = emptySave(preview);
    for (const value of [
      { ...save, version: 2 },
      { ...save, events: [event('a', 'expedition.started', 'basalt-1')] },
      { ...save, events: [{ ...event('a', 'visit'), createdAt: -1 }] },
      { ...save, events: [event('a', 'visit'), event('a', 'visit')] },
      { ...save, ship: { ...save.ship, name: 'x'.repeat(61) } },
    ]) expect(() => validateSave(value, preview)).toThrow();
  });
});
