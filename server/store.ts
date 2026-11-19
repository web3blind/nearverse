import Database from 'better-sqlite3';
import { chmodSync, existsSync } from 'node:fs';
export function openStore(path = ':memory:') {
  const db = new Database(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  if (Number(db.pragma('user_version',{simple:true})) > 2) {db.close();throw new Error('unsupported_schema');}
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, eventId TEXT NOT NULL, type TEXT NOT NULL, systemId TEXT NOT NULL, storyId TEXT, createdAt INTEGER NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, operation TEXT, UNIQUE(owner,eventId), UNIQUE(operation));
    CREATE TABLE IF NOT EXISTS journal_revisions (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS season_chapters (id TEXT PRIMARY KEY, systemId TEXT NOT NULL, releaseAt TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ships (owner TEXT PRIMARY KEY, name TEXT NOT NULL, biography TEXT NOT NULL, art TEXT NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_owner ON events(owner,seq); PRAGMA user_version = 2;`);
  return db;
}
export async function backupStore(db: Database.Database, destination: string) {
  if (existsSync(destination)) throw new Error('backup_target_exists');
  await db.backup(destination);
  chmodSync(destination, 0o600);
  const check = new Database(destination, { readonly: true });
  try { if (check.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup_integrity'); }
  finally { check.close(); }
}
// Restore into a NEW path only; caller must stop the service before changing its configured database.
export async function restoreStore(source: string, destination: string) {
  if (existsSync(destination)) throw new Error('restore_target_exists');
  const check = new Database(source, { readonly: true, fileMustExist: true });
  try {
    if (check.pragma('integrity_check', { simple: true }) !== 'ok' || ![1,2].includes(Number(check.pragma('user_version', { simple: true })))) throw new Error('invalid_backup');
    await backupStore(check, destination);
    // Login challenges and cookies never regain validity after recovery.
    const restored = new Database(destination);
    try { restored.exec('DELETE FROM sessions; DELETE FROM challenges;'); } finally { restored.close(); }
  } finally { check.close(); }
}
