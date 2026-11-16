// Separate process: a crash, hang or memory problem here cannot stop the main site.
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openMcpStore } from './store';
import { mainClient } from './main-client';
import { createMcpApp } from './app';

const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:5173';
// Same rules as the main server: canonical origin, https unless loopback.
if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be canonical, without a trailing slash');
if (!origin.startsWith('https:') && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('APP_ORIGIN must use https');
const secret = Buffer.from(process.env.MCP_SECRET || '', 'hex');
const path = resolve(process.env.MCP_DB || 'data/mcp.sqlite');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700);
const store = openMcpStore(path, secret); chmodSync(path, 0o600);
const history = process.env.HISTORY_API || 'http://127.0.0.1:4318';
const linkSecret = process.env.AGENT_LINK_SECRET || '';
if (linkSecret.length < 32) { console.error('AGENT_LINK_SECRET must be set (at least 32 characters, shared with the history server).'); process.exit(1); }
// The secret and sessions go only to the history server on this machine.
if (!['127.0.0.1', '[::1]', 'localhost'].includes(new URL(history).hostname)) { console.error('HISTORY_API must be a loopback URL.'); process.exit(1); }
// Budgets of the shared history API (120/min for everyone behind nginx): tools 15, challenge 3, verify 3, logout 3.
const client = mainClient(history, origin, 15);
const challengeClient = mainClient(history, origin, 3, 8000, linkSecret); const linkClient = mainClient(history, origin, 3, 8000, linkSecret); const logoutClient = mainClient(history, origin, 3);
const app = createMcpApp({ origin, store, client, linkClient, challengeClient, logoutClient, staticDir: resolve(process.env.MCP_STATIC || 'dist-mcp') });
const port = Number(process.env.MCP_PORT || 4320);
const server = app.listen(port, '127.0.0.1', () => console.log(`MCP module listening on 127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => { store.close(); process.exit(0); }));
