import { openDB, type IDBPDatabase } from 'idb';
import { getSystem, systems } from './world';

export type GameMode = 'real' | 'preview';
export interface Scope { mode: GameMode; account: string | null }
export interface Ship { name: string; biography: string; art: 'courier' | 'surveyor' | 'sail' }
export interface GameEvent {
  eventId: string;
  type: 'visit' | 'arrival' | 'expedition.started' | 'expedition.completed' | 'story.read';
  systemId: string;
  storyId?: string;
  createdAt: number;
  readyAt?: number;
}
export interface GameSave { version: 1; scope: Scope; ship: Ship; events: GameEvent[]; queue: string[] }
export interface Cache { get(key: string): Promise<unknown>; set(key: string, value: GameSave): Promise<void> }
export interface HistoryTransport {
  // Ownership/session validation belongs to the server. Never use an address alone as authorization.
  read(account: string): Promise<GameEvent[]>;
  append(account: string, event: GameEvent): Promise<GameEvent>;
}
export const MAX_EXPORT_BYTES = 512 * 1024;
export const MAX_EVENTS = 1500;
export const defaultShip: Ship = { name: 'Quiet Wanderer', biography: 'This ship once carried mail between distant stations. Now its crew collects stories of those who know how to wait, remember and return.', art: 'courier' };
const eventTypes = ['visit', 'arrival', 'expedition.started', 'expedition.completed', 'story.read'];
const identity = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export function scopeKey(scope: Scope): string {
  if (!['real', 'preview'].includes(scope.mode) || (scope.account !== null && (!identity.test(scope.account) || scope.account.length < 2 || scope.account.length > 64))) throw new Error('Invalid account');
  return `${scope.mode}:${scope.account ?? 'guest'}`;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a save object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Invalid text field');
  return value;
}
export function validateEvent(input: unknown): GameEvent {
  const value = object(input);
  const eventId = text(value.eventId, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(eventId) || !eventTypes.includes(String(value.type))) throw new Error('Unknown event');
  const systemId = text(value.systemId, 64);
  const system = getSystem(systemId);
  const type = value.type as GameEvent['type'];
  const storyId = value.storyId === undefined ? undefined : text(value.storyId, 64);
  if ((['visit', 'arrival'].includes(type) && storyId !== undefined) || (!['visit', 'arrival'].includes(type) && !system.stories.some(story => story.id === storyId))) throw new Error('Story does not belong to this system');
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 || (value.createdAt as number) > 8640000000000000) throw new Error('Invalid timestamp');
  if (value.readyAt !== undefined && (!Number.isSafeInteger(value.readyAt) || (value.readyAt as number) < 0)) throw new Error('Invalid completion time');
  return { eventId, type, systemId, ...(storyId ? { storyId } : {}), createdAt: value.createdAt as number, ...(value.readyAt !== undefined ? { readyAt: value.readyAt as number } : {}) };
}
export function emptySave(scope: Scope): GameSave {
  scopeKey(scope);
  return { version: 1, scope: { ...scope }, ship: { ...defaultShip }, events: [], queue: [] };
}
export function validateSave(input: unknown, expectedScope: Scope): GameSave {
  const value = object(input);
  if (value.version !== 1) throw new Error('Unsupported save version');
  const scope = object(value.scope) as unknown as Scope;
  if (scopeKey(scope) !== scopeKey(expectedScope)) throw new Error('This save belongs to a different account or mode. Preview data cannot be transferred to the real log.');
  const ship = object(value.ship);
  if (!['courier', 'surveyor', 'sail'].includes(String(ship.art))) throw new Error('Unknown built-in ship');
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS || !Array.isArray(value.queue)) throw new Error('Log size limit exceeded');
  const events = value.events.map(validateEvent);
  const ids = new Set(events.map(event => event.eventId));
  if (ids.size !== events.length || value.queue.length > MAX_EVENTS || value.queue.some(id => typeof id !== 'string' || !ids.has(id))) throw new Error('Invalid queue or duplicate entries');
  validateSequence(events);
  return { version: 1, scope: { mode: scope.mode, account: scope.account }, ship: { name: text(ship.name, 60), biography: text(ship.biography, 2000, true), art: ship.art as Ship['art'] }, events, queue: scope.mode === 'preview' ? [] : [...new Set(value.queue as string[])] };
}
export function validateSequence(events: GameEvent[]): void {
  const visited = new Set<string>();
  const started = new Set<string>();
  const completed = new Set<string>();
  for (const event of events) {
    if (event.type === 'visit' || event.type === 'arrival') { visited.add(event.systemId); continue; }
    const system = getSystem(event.systemId);
    const index = system.stories.findIndex(story => story.id === event.storyId);
    if (![...visited].some(id => getSystem(id).asset === system.asset) || (index > 0 && !completed.has(system.stories[index - 1].id))) throw new Error('Invalid expedition order');
    if (event.type === 'expedition.started') {
      if (completed.has(event.storyId!) || started.has(event.storyId!)) throw new Error('Expedition already started');
      if ([...started].some(id => !completed.has(`finished:${id}`))) throw new Error('Complete the active expedition first');
      started.add(event.storyId!);
    } else if (event.type === 'expedition.completed') {
      if (!started.has(event.storyId!) || completed.has(`finished:${event.storyId}`)) throw new Error('Expedition was not started');
      completed.add(`finished:${event.storyId}`);
    } else {
      if (!completed.has(`finished:${event.storyId}`) || completed.has(event.storyId!)) throw new Error('Expedition was not started');
      completed.add(event.storyId!);
    }
  }
}
let database: Promise<IDBPDatabase> | undefined;
function db() {
  if (!database) database = openDB('nearverse-game-v1', 1, { upgrade(database) { database.createObjectStore('saves'); } }).catch(error => { database = undefined; throw error; });
  return database;
}
export const indexedCache: Cache = {
  async get(key) { return (await db()).get('saves', key); },
  async set(key, value) { await (await db()).put('saves', value, key); },
};
export function createGameStorage(cache: Cache = indexedCache) {
  // Serialize all read/modify/write work, including account switches and background retries.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  }
  async function load(scope: Scope): Promise<GameSave> {
    const value = await cache.get(scopeKey(scope));
    if (value === undefined) return emptySave(scope);
    try { return validateSave(value, scope); }
    catch (error) {
      // A real-mode cache from before swap-only rules (free Lada chapters) no longer validates.
      // The server journal is the source of truth: drop the cached events, keep the ship.
      if (scope.mode !== 'real' || !value || typeof value !== 'object') throw error;
      return validateSave({ ...(value as object), events: [], queue: [] }, scope);
    }
  }
  return {
    load(scope: Scope) { return serial(() => load(scope)); },
    saveShip(scope: Scope, ship: Ship) { return serial(async () => {
      const save = await load(scope);
      save.ship = ship;
      const validated = validateSave(save, scope);
      await cache.set(scopeKey(scope), validated);
      return validated;
    }); },
    append(scope: Scope, event: GameEvent) { return serial(async () => {
      const save = await load(scope);
      const validated = validateEvent(event);
      if (scope.mode === 'real' && ['visit', 'arrival'].includes(event.type)) throw new Error('Only the server can record a real arrival');
      const previous = save.events.find(item => item.eventId === event.eventId);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(validated)) throw new Error('Event ID is already in use');
        return save;
      }
      save.events.push(validated);
      if (scope.mode === 'real') save.queue.push(event.eventId);
      const next = validateSave(save, scope);
      await cache.set(scopeKey(scope), next);
      return next;
    }); },
    export(scope: Scope) { return serial(async () => {
      const raw = JSON.stringify(await load(scope), null, 2);
      if (new TextEncoder().encode(raw).length > MAX_EXPORT_BYTES) throw new Error('Export exceeds 512 KiB');
      return raw;
    }); },
    import(scope: Scope, raw: string) { return serial(async () => {
      if (new TextEncoder().encode(raw).length > MAX_EXPORT_BYTES) throw new Error('File exceeds 512 KiB');
      const save = validateSave(JSON.parse(raw), scope);
      // Real history is restored from the authenticated server, never from imported financial claims.
      if (scope.mode === 'real') {
        const existing = await load(scope);
        save.events = existing.events;
        save.queue = existing.queue;
      }
      await cache.set(scopeKey(scope), save);
      return save;
    }); },
    clearHistory(scope: Scope) { return serial(async () => {
      const save = await load(scope); save.events = [];save.queue = [];
      await cache.set(scopeKey(scope), save);return save;
    }); },
    clear(scope: Scope) { return serial(async () => {
      const save = emptySave(scope);
      await cache.set(scopeKey(scope), save);
      return save;
    }); },
    sync(scope: Scope, transport: HistoryTransport) { return serial(async () => {
      if (scope.mode !== 'real' || !scope.account) throw new Error('Preview and guest data cannot be synced');
      const save = await load(scope);
      const remote = (await transport.read(scope.account)).map(validateEvent);
      if (remote.length > MAX_EVENTS) throw new Error('Server log is too large');
      validateSequence(remote);
      if (new Set(remote.map(event => event.eventId)).size !== remote.length) throw new Error('Server returned duplicate entries');
      const known = new Map(remote.map(event => [event.eventId, event]));
      for (const eventId of [...save.queue]) {
        const event = save.events.find(item => item.eventId === eventId)!;
        const ack = known.get(eventId) ?? validateEvent(await transport.append(scope.account, event));
        if (ack.eventId !== event.eventId || ack.type !== event.type || ack.systemId !== event.systemId || ack.storyId !== event.storyId) throw new Error('Server acknowledged a different event');
        known.set(eventId, ack);
        save.events = save.events.map(item => item.eventId === eventId ? ack : item);
        save.queue = save.queue.filter(id => id !== eventId);
        await cache.set(scopeKey(scope), save);
      }
      const pendingIds = new Set(save.queue);
      save.events = [...known.values(), ...save.events.filter(event => pendingIds.has(event.eventId))];
      const next = validateSave(save, scope);
      await cache.set(scopeKey(scope), next);
      return next;
    }); },
  };
}
export const gameStorage = createGameStorage();
export function makeEvent(type: GameEvent['type'], systemId: string, storyId?: string): GameEvent {
  return { eventId: crypto.randomUUID(), type, systemId, ...(storyId ? { storyId } : {}), createdAt: Date.now() };
}
export function progress(save: GameSave, systemId: string) {
  const system = getSystem(systemId);
  const completed = new Set(save.events.filter(event => event.type === 'story.read').map(event => event.storyId));
  const next = system.stories.find(story => !completed.has(story.id));
  const active = next ? save.events.find(event => event.type === 'expedition.started' && event.storyId === next.id) : undefined;
  return { visited: save.events.some(event => ['visit', 'arrival'].includes(event.type) && getSystem(event.systemId).asset === system.asset), completed, next, active };
}
export function visitedCount(save: GameSave): number {
  return systems.filter(system => save.events.some(event => ['visit', 'arrival'].includes(event.type) && event.systemId === system.id)).length;
}
