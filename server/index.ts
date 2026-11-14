import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app';
import express from 'express';
import { frontend } from './frontend';
import { openStore, backupStore, restoreStore } from './store';

const path = resolve(process.env.HISTORY_DB || 'data/history.sqlite');
const dir = dirname(path); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
const [command, target, destination] = process.argv.slice(2);
if (command === 'restore') {
  if (!target || !destination) throw new Error('Usage: tsx server/index.ts restore BACKUP NEW_DATABASE');
  await restoreStore(resolve(target), resolve(destination));
  console.log('Restored to new database; active sessions revoked. Service must be stopped before switching HISTORY_DB.');
} else {
  const db = openStore(path);
  if (command === 'backup') {
    if (!target) throw new Error('Usage: tsx server/index.ts backup NEW_BACKUP');
    try { await backupStore(db, resolve(target)); console.log('Backup complete.'); } finally { db.close(); }
  } else {
    const port = Number(process.env.PORT || (command === 'preview' ? 4319 : 4318));
    const origin = process.env.APP_ORIGIN || (command === 'preview' ? 'http://127.0.0.1:4319' : 'http://127.0.0.1:5173');
    const app = express();
    // Deployment diagnostics deliberately exclude URL/query/header/body values.
    app.use((req, res, next) => {
      const started = performance.now();
      const routes = new Set(['/api/health', '/api/auth/session', '/api/events', '/api/journal', '/']);
      const route = routes.has(req.path) ? req.path : '[other]';
      const method = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']).has(req.method) ? req.method : '[other]';
      res.once('finish', () => {
        const entry = JSON.stringify({ time: new Date().toISOString(), event: 'http_response', method, route, status: res.statusCode, durationMs: Math.round(performance.now() - started) });
        if (res.statusCode >= 500) console.error(entry); else console.log(entry);
      });
      next();
    });
    if(command === 'preview') app.use(frontend());
    app.use(createApp({ origin, db }));
    const server = app.listen(port, '127.0.0.1', () => console.log(`History backend listening on 127.0.0.1:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
  }
}
