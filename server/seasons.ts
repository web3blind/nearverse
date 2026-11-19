// Seasonal chapters live in a runtime JSON file, not in the site bundle: texts are served only
// to players who have read them, and new chapters can be released without a rebuild.
// The file is append-only: a chapter, once loaded, is never dropped, moved or re-timed,
// because player journals reference it and its place in the chapter chain.
import { readFileSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { systems } from '../src/world';

export interface SeasonChapter { id: string; systemId: string; title: string; text: string; releaseAt: string }
export const SEASON_CHAPTER_SECONDS = 3600;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const order = (a: SeasonChapter, b: SeasonChapter) => Date.parse(a.releaseAt) - Date.parse(b.releaseAt) || a.id.localeCompare(b.id);

export function validateSeason(value: unknown): SeasonChapter[] {
  const list = (value as { chapters?: unknown })?.chapters;
  if (!Array.isArray(list) || list.length > 2000) throw new Error('invalid_season_file');
  const ids = new Set(systems.flatMap(s => s.stories.filter(x => !x.seasonal).map(x => x.id)));
  return list.map(item => {
    const c = item as SeasonChapter;
    if (!c || typeof c !== 'object' || Object.keys(c).sort().join() !== 'id,releaseAt,systemId,text,title'
      || typeof c.id !== 'string' || !idPattern.test(c.id) || c.id.length > 64 || ids.has(c.id)
      || !systems.some(s => s.id === c.systemId)
      || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 80
      || typeof c.text !== 'string' || !c.text.trim() || c.text.length > 2000
      || typeof c.releaseAt !== 'string' || Number.isNaN(Date.parse(c.releaseAt))) throw new Error('invalid_season_chapter');
    ids.add(c.id);
    return { id: c.id, systemId: c.systemId, title: c.title, text: c.text, releaseAt: new Date(Date.parse(c.releaseAt)).toISOString() };
  }).sort(order);
}

/** Strict read used at startup: a missing file is an empty season, a broken one stops the server. */
export function loadSeasonFile(path?: string): SeasonChapter[] {
  if (!path) return [];
  try { statSync(path); } catch { return []; }
  return validateSeason(JSON.parse(readFileSync(path, 'utf8')));
}

/** Re-reads the file only when its mtime changes (also after a failed read). Chapters are kept in the
 *  history database, so they survive restarts: once stored, a chapter is never dropped, moved to another
 *  system or re-timed (title and text fixes are allowed). A new chapter released before the latest stored
 *  chapter of its system is refused, so the chain of chapters never changes order. */
export function seasonSource(path: string | undefined, db: Database.Database) {
  const all = () => (db.prepare('SELECT id,systemId,releaseAt,title,text FROM season_chapters').all() as SeasonChapter[]).sort(order);
  const merge = db.transaction((list: SeasonChapter[]) => {
    const latest = new Map<string, number>();
    for (const c of all()) latest.set(c.systemId, Math.max(latest.get(c.systemId) ?? 0, Date.parse(c.releaseAt)));
    for (const c of list) {
      const old = db.prepare('SELECT id FROM season_chapters WHERE id=?').get(c.id);
      if (old) { db.prepare('UPDATE season_chapters SET title=?, text=? WHERE id=?').run(c.title, c.text, c.id); continue; }
      if (Date.parse(c.releaseAt) <= (latest.get(c.systemId) ?? 0)) { console.warn(`season: refused back-dated chapter ${c.id}`); continue; }
      db.prepare('INSERT INTO season_chapters VALUES (?,?,?,?,?)').run(c.id, c.systemId, c.releaseAt, c.title, c.text);
      latest.set(c.systemId, Date.parse(c.releaseAt));
    }
  });
  let mtime = -1; let sorted: SeasonChapter[];
  merge(loadSeasonFile(path)); sorted = all();
  try { if (path) mtime = statSync(path).mtimeMs; } catch { /* no file yet */ }
  return (): SeasonChapter[] => {
    if (!path) return sorted;
    try {
      const next = statSync(path).mtimeMs;
      if (next !== mtime) { mtime = next; merge(validateSeason(JSON.parse(readFileSync(path, 'utf8')))); sorted = all(); }
    } catch { /* missing or invalid file: keep every stored chapter */ }
    return sorted;
  };
}
export function released(chapters: SeasonChapter[], now: number) {
  return chapters.filter(c => Date.parse(c.releaseAt) <= now);
}
