// Game rules shared by the server (authority), the site and the MCP module.
// One swap opens one system, and only along that system's route. The third chapter
// needs a return trip: one more swap into the same system after the second chapter.
import { assetIds, type Asset } from './assets';
import { systems, type StarSystem } from './world';

/** Arrivals recorded before this moment open every system of their asset (the original rule). */
export const RULES_V2_AT = Date.parse('2026-11-18T14:30:00Z');

/** Source assets that open each system. Every route is reachable starting from NEAR alone. */
export const routes: Record<string, { from: Asset[]; story: string }> = {
  'near-lada': { from: ['USDT', 'USDC', 'BTC', 'ETH', 'SOL'], story: 'any cargo exchanged into NEAR' },
  'near-echo': { from: ['USDT'], story: 'from the Harbor waystations' },
  'usdt-harbor': { from: ['NEAR'], story: 'from the gardens of the Near Arm' },
  'usdt-linen': { from: ['SOL'], story: 'on a pulse from the Pulse Arm' },
  'usdc-balance': { from: ['USDT'], story: 'from the Harbor berths' },
  'sol-pulse': { from: ['USDC'], story: 'from the shared reserves of Equilibrium' },
  'btc-basalt': { from: ['NEAR'], story: 'from the Near Arm' },
  'btc-ember': { from: ['ETH'], story: 'from the Weaver’s Nebula' },
  'eth-weft': { from: ['BTC'], story: 'from the Stone Frontier' },
  'eth-prism': { from: ['SOL'], story: 'on light from the Pulse Arm' },
};
/** The return trip is required before this chapter (0-based index). */
export const RETURN_CHAPTER = 2;

export interface RuleEvent { type: string; systemId: string; storyId?: string | null; createdAt: number }

const assetOf = (assetId: string) => (Object.keys(assetIds) as Asset[]).find(asset => assetIds[asset] === assetId);
export function routeSources(systemId: string): Asset[] { return routes[systemId]?.from ?? []; }
export function routeLabel(systemId: string): string {
  const system = systems.find(s => s.id === systemId); const from = routeSources(systemId);
  return system ? `${from.length > 1 ? 'any of ' + from.join(', ') : from[0]} → ${system.asset}` : '';
}
/** Is a swap from `originAssetId` a valid passage into this system? */
export function routeAllowed(systemId: string, originAssetId: string): boolean {
  const asset = assetOf(originAssetId); return !!asset && routeSources(systemId).includes(asset);
}
export function isOpen(system: StarSystem, events: RuleEvent[]): boolean {
  return events.some(e => e.type === 'arrival' && (e.systemId === system.id
    || (e.createdAt < RULES_V2_AT && systems.find(s => s.id === e.systemId)?.asset === system.asset)));
}
const readAt = (events: RuleEvent[], systemId: string, storyId: string) => events.find(e => e.type === 'story.read' && e.systemId === systemId && e.storyId === storyId)?.createdAt;
/** Story index `index` needs a return arrival that has not happened yet. */
export function returnPending(system: StarSystem, index: number, events: RuleEvent[]): boolean {
  if (index !== RETURN_CHAPTER || !system.stories[index - 1]) return false;
  const previous = readAt(events, system.id, system.stories[index - 1].id);
  if (previous === undefined) return false;
  // Chapter 2 begun under the old rules keeps chapter 3 free.
  const begun = events.find(e => e.type === 'expedition.started' && e.systemId === system.id && e.storyId === system.stories[index - 1].id)?.createdAt ?? previous;
  if (Math.min(begun, previous) < RULES_V2_AT) return false;
  return !events.some(e => e.type === 'arrival' && e.systemId === system.id && e.createdAt >= previous);
}
/** The swap the player needs next for this system, if any. */
export function arrivalNeeded(system: StarSystem, events: RuleEvent[]): 'first' | 'return' | null {
  if (!isOpen(system, events)) return 'first';
  const next = system.stories.findIndex(story => readAt(events, system.id, story.id) === undefined);
  return next >= 0 && returnPending(system, next, events) ? 'return' : null;
}

export const levelTitles = ['Deckhand', 'Navigator', 'Pathfinder', 'Wayfarer', 'Chronicler', 'Star Cartographer', 'Beacon Keeper', 'Voyager of the Arms', 'Keeper of Threads', 'Atlas Bearer', 'Legend of the Atlas'];
/** Explorer level grows with chapters read (every 3) and systems reached; never with money. */
export function explorerLevel(events: RuleEvent[]) {
  const chapters = new Set(events.filter(e => e.type === 'story.read').map(e => `${e.systemId}/${e.storyId}`)).size;
  const reached = systems.filter(system => isOpen(system, events)).length;
  const points = chapters + Math.floor(reached / 2);
  const level = 1 + Math.floor(points / 3);
  return { level, title: levelTitles[Math.min(level, levelTitles.length) - 1], chapters, systems: reached, nextLevelIn: 3 - (points % 3) };
}
