// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { arrivalNeeded, explorerLevel, isOpen, returnPending, routeAllowed, RULES_V2_AT, routes } from '../src/rules';
import { getSystem, systems } from '../src/world';
import { assetIds } from '../src/assets';

const t = RULES_V2_AT + 1000;
const ev = (type: string, systemId: string, createdAt = t, storyId?: string) => ({ type, systemId, storyId, createdAt });
describe('game rules', () => {
  it('gives every system a reachable route that starts from NEAR alone', () => {
    expect(Object.keys(routes).sort()).toEqual(systems.map(s => s.id).sort());
    const held = new Set(['NEAR']); let grew = true;
    while (grew) { grew = false; for (const s of systems) if (!held.has(s.asset) && routes[s.id].from.some(a => held.has(a))) { held.add(s.asset); grew = true; } }
    expect(held.size).toBe(6);
    for (const s of systems) expect(routes[s.id].from).not.toContain(s.asset);
  });
  it('accepts only route sources and treats native NEAR as NEAR', () => {
    expect(routeAllowed('btc-basalt', assetIds.NEAR)).toBe(true);
    expect(routeAllowed('btc-basalt', assetIds.USDC)).toBe(false);
    expect(routeAllowed('near-echo', assetIds.USDT)).toBe(true);
  });
  it('opens one system per arrival; older arrivals still open their whole asset region', () => {
    const basalt = getSystem('btc-basalt'), ember = getSystem('btc-ember');
    expect(isOpen(ember, [ev('arrival', 'btc-basalt')])).toBe(false);
    expect(isOpen(basalt, [ev('arrival', 'btc-basalt')])).toBe(true);
    expect(isOpen(ember, [ev('arrival', 'btc-basalt', RULES_V2_AT - 1)])).toBe(true);
  });
  it('needs a return arrival after chapter 2 before chapter 3', () => {
    const s = getSystem('usdt-harbor'); const [a, b] = s.stories;
    const history = [ev('arrival', s.id, t), ev('story.read', s.id, t + 10, a.id), ev('story.read', s.id, t + 20, b.id)];
    expect(returnPending(s, 2, history)).toBe(true); expect(arrivalNeeded(s, history)).toBe('return');
    const back = [...history, ev('arrival', s.id, t + 30)];
    expect(returnPending(s, 2, back)).toBe(false); expect(arrivalNeeded(s, back)).toBeNull();
    expect(arrivalNeeded(getSystem('sol-pulse'), back)).toBe('first');
  });
  it('keeps chapter 3 free for players who read chapter 2 before the change', () => {
    const s = getSystem('usdt-harbor'); const [a, b] = s.stories; const old = RULES_V2_AT - 100;
    expect(returnPending(s, 2, [ev('arrival', s.id, old - 10), ev('story.read', s.id, old - 5, a.id), ev('story.read', s.id, old, b.id)])).toBe(false);
    // Started before the change, read after it: still free.
    expect(returnPending(s, 2, [ev('arrival', s.id, old - 10), ev('story.read', s.id, old - 5, a.id), ev('expedition.started', s.id, old, b.id), ev('story.read', s.id, t + 7200000, b.id)])).toBe(false);
  });
  it('orders seasonal chapters by release time whatever order they arrive in', async () => {
    const { registerSeason } = await import('../src/world');
    registerSeason([{ id: 'echo-t2', systemId: 'near-echo', title: 'B', durationSeconds: 3600, releaseAt: '2030-01-02T00:00:00Z' }]);
    registerSeason([{ id: 'echo-t1', systemId: 'near-echo', title: 'A', durationSeconds: 3600, releaseAt: '2030-01-01T00:00:00Z' }]);
    expect(getSystem('near-echo').stories.slice(3).map(s => s.id)).toEqual(['echo-t1', 'echo-t2']);
  });
  it('grows the explorer level with chapters and systems, never with money', () => {
    expect(explorerLevel([]).level).toBe(1);
    const reads = systems.slice(0, 2).flatMap(s => [ev('arrival', s.id), ...s.stories.slice(0, 3).map(x => ev('story.read', s.id, t, x.id))]);
    expect(explorerLevel(reads)).toMatchObject({ level: 3, chapters: 6, systems: 2 });
  });
});
