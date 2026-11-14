import { systems } from '../src/world';
import type { HistorySystem } from './app';
import { assetIds as assets } from '../src/assets';
export const historySystems: HistorySystem[] = systems.map(system => ({
  id: system.id, assetId: assets[system.asset], stories: system.stories.map((story, index) => ({
    id: story.id, durationMs: story.durationSeconds * 1000, requires: index ? [system.stories[index - 1].id] : [],
  })),
}));
export const homeSystemId = 'near-lada';
