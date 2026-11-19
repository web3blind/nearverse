# NearVerse

NearVerse is an English-language space exploration interface for real swaps through NEAR Intents. Its six asset regions contain ten systems and thirty sequential story chapters. NEAR, USDC, BTC, ETH and SOL are the main regions; USDT remains an alternative. A passage represents a swap, not a separate financial instrument or a promise of profit. After arrival, systems in the same asset region can be explored without additional swaps.

The application uses React, TypeScript and Vite, with a small Node/SQLite history backend. Aurora Intents core is pinned to 7.29.0 and the supported NEAR connector to 0.6.11. The existing standalone package remains locked for reproducibility but is not imported into the runtime. The map has an equivalent keyboard-accessible destination list, system illustrations have text descriptions, and expeditions resume from their saved timestamps.

## NEAR HACKATHON: Build Beyond Boundaries

Live application: [nearverse.space](https://nearverse.space).

NearVerse was developed for the November 2026 NEAR HACKATHON. Local development history runs from November 8 to November 16, 2026; the public repository contains a consolidated source snapshot rather than that development history. The application turns real NEAR Intents swaps into passages between fictional asset regions: a system, its description and its story chapters open only after a real swap into its asset that the server verifies. NEAR provides the account identity; NEAR Intents and Aurora's integration provide quotes, asset conversion and settlement. This is an interface built on existing infrastructure, not a new exchange protocol. AI agents can play the same game through a remote MCP server, with owner-set spending limits.

Third-party foundations include React, Vite, Aurora Intents core and the supported NEAR connector; exact dependencies and versions are recorded in `package.json` and `package-lock.json`. NearVerse's application code is available under the [MIT License](LICENSE); dependencies retain their own licenses.

### A short path for judges

1. Open the live application. Without a wallet, the atlas shows only system names and assets; there is no swap-free mode.
2. Connect a NEAR wallet and sign in (a text message, not a transaction). Select a closed system from the keyboard-accessible destination list.
3. In the Converter, swap a small amount (any amount is accepted) along that system's route, for example NEAR → USDT for Harbor. One swap opens one system. Chapter 2 is a two-hour expedition, chapter 3 needs a return swap along the same route, and new seasonal chapters arrive weekly. The ship panel shows an explorer level that grows with chapters read, not with money. Read the financial safety section first: a quote or a signed deposit is not proof of settlement, and real swaps use your own funds.
4. After the server verifies the arrival, the system's description and first chapter unlock. Start an expedition, reload, and complete it after its timer to read the chapter.
5. For agents: open [nearverse.space/mcp/](https://nearverse.space/mcp/), set limits, sign, and give the token to an MCP client. See "AI agents (MCP)" below and [llms.txt](https://nearverse.space/llms.txt).

## Setup

Use Node 22 and npm 10 on a dedicated development/build machine with sufficient memory. Dependency installation, the complete test suite and production bundling are resource-intensive: do not run them on a shared production host. The build's 4096 MiB JavaScript heap limit does not bound all subprocess memory.

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run test:icons
npm run build
npm run preview
```

`npm run build` produces the default minified Vite output in `dist/`. `npm run preview` serves that output and the history API on `http://127.0.0.1:4319/`. This command is a loopback server, not an automatic public deployment. The default database is `data/history.sqlite`.

For development, run these in separate terminals:

```sh
APP_ORIGIN=http://127.0.0.1:5173 PORT=4318 npm run server
npm run dev
```

Vite serves `http://127.0.0.1:5173` and proxies `/api` to the history backend on port 4318. When changing the frontend origin, set `APP_ORIGIN` accordingly; do not disable Origin checks. The backend reads `APP_ORIGIN`, `PORT` and `HISTORY_DB` from its process environment.

Set `VITE_AURORA_API_KEY` in a local `.env.local` or in the build process environment. It is a **public client integration key**, embedded by Vite at build time. Never place a seed, private key, password or partner API secret in any `VITE_*` variable. Missing configuration blocks live quotes/swaps rather than substituting a fixture quote. Do not copy an entire secret environment file to a build server.

The committed `.npmrc` is required for lockfile-compatible peer resolution. Native SQLite installation may require Python and a C/C++ toolchain. The exact material-icon alias in `vite.config.ts` avoids importing a large icon barrel while retaining the original per-icon components; `test:icons` verifies its consumers and development/test/build mappings. Do not edit `node_modules` to change application behavior.

## Preview and accessibility checks

There is no swap-free mode: every system, its description and its chapters open only after a real swap into the system's asset that the server verifies. Without a wallet, the atlas shows only system names and assets. With a wallet, try editing the ship, swapping a small amount, starting an expedition, reloading and completing it after its timer. Select a destination from the text list and verify that focus moves to its heading. Check keyboard navigation, narrow screens and reduced-motion settings.

Export/import accepts bounded plain JSON for the same mode/account. Live imports change only local ship settings, never verified arrivals. User biographies are rendered as text, not HTML. Built-in ship art is used instead of arbitrary uploads.

Automated tests cover UI behavior, storage isolation, authenticated HTTP history, quote binding, signing guards, recovery and consent revocation. Controlled offline signers, mocked providers and dry quotes are not mainnet swaps. Successful tests or bundling do not constitute independent real-wallet financial acceptance.

## Financial safety

- The first screen has an active **Connect NEAR wallet** button. One click loads the financial module and opens the NEAR selector backed by the official connector; it does not request a swap signature. The game shell and cached-account return visits do not load the SDK until requested. A pending or unreadable recovery record is visibly fenced before activation.
- Connection uses the genuine NEAR connector wallet through the public core provider contract, not the universal multichain wallet wrapper. Wallet accounts remain NEAR; BTC, ETH, SOL, USDC, USDT and wNEAR Intents destinations remain available. The activated provider/store stays mounted across destination and preview changes. The selector uses native dialog/button semantics and the official connector's `availableWallets` and `connect(id)` public APIs. Its built-in pointer-only `.connect-item` popup is not patched or imported as a universal wallet UI. Native NEAR signing, account lookup and transaction guards remain in the official connector and core SDK.
- Token identity is matched by exact asset ID and custody, not symbol alone. See `src/assets.ts`. BTC/ETH/SOL in the Intents balance are not automatic withdrawals to their native chains. Supported balances do not represent a full portfolio; staked assets and NFTs are outside scope.
- Amounts use smallest-unit strings and BigInt. Signing requires a fresh bound quote, the correct account/assets/amounts/deadline, displayed fees and explicit consent. A supported asset does not guarantee a liquid route.
- Revoking consent, changing conditions, switching to preview or unmounting blocks a stale attempt before its next wallet call. Re-checking consent does not revive an old attempt. This cannot cancel a wallet call or transaction already sent.
- Recovery metadata is saved before signing. Unknown or pending outcomes block another transfer; reload restores status rather than resubmitting. Do not erase recovery or budget records to bypass this protection. Refunded/failed operations require explicit acknowledgement of a matching final upstream result.
- A transaction signature or deposit submission is not arrival. The backend independently verifies final success and operation binding before recording a live arrival.
- Any connected NEAR account can swap any amount it explicitly approves; the site sets no account allowlist or amount cap. Spending limits belong to the user or to an agent operating the site. Account/storage/gas reserves are checked before wallet calls, and a per-account operation ledger rejects resubmitting an already accounted signature.
- NearVerse passes `appFees: []`; this does not mean upstream fees are zero. Actual applied fees must be read from the bound quote. No additional integrator fee is configured by this release.

Do not perform financial acceptance, connect a personal wallet or change fee settings merely because a build/deployment succeeded. Wallet tests and any spending require their own explicit scope and approval.

## History, privacy and operations

History access requires a separate NEP-413 ownership sign-in: connecting an address alone is not authentication. Domain/nonce/expiry/account and the account's access key are checked. Sessions use HttpOnly/SameSite cookies, Secure on HTTPS, expiry/revocation and Origin checks. Account changes invalidate access to another account's history.

SQLite stores validated exploration events and minimal recovery bindings, not a portfolio, seed, private key or signed transaction archive. Expedition times are server-authoritative. IndexedDB is an account/mode-isolated cache and retry queue; unconfirmed writes remain visibly unsynced. Ship names, biographies and built-in appearance stay local. Public stories/art can be downloaded directly. Wallets, RPC providers and Aurora still see the information required for their operations; anonymity is not promised.

Export and deletion concern the user's journal. Local deletion does not delete server history, and server deletion does not undo a blockchain operation. See [server/CONTRACT.md](server/CONTRACT.md) for the API contract and [DEPENDENCY-SECURITY.md](DEPENDENCY-SECURITY.md) for dependency review. Third-party dependencies and untested wallet paths remain separate security-review concerns.

### Backup and restore

Use SQLite's online backup API rather than copying only the main file of a running WAL database:

```sh
npm run server -- backup data/history-backup.sqlite
npm run server -- restore data/history-backup.sqlite data/history-restored.sqlite
```

Existing destinations are not overwritten. Restore validates the database and revokes sessions/challenges. Stop the relevant service before switching `HISTORY_DB`; preserve the original database and its sidecars until rollback is no longer needed. Keep backups outside public web roots with restricted access.

### Frontend-only deployment

Build and test on an isolated machine, retain source/artifact SHA-256 manifests and complete command logs, and transfer only the verified `dist/`. Back up the existing public assets before an atomic swap. Preserve the serving backend, its environment/configuration, database (including WAL/SHM), logs, service identity and neighboring sites. Do not deploy the repository's backend over a production backend carrying operational logging changes. An assets-only update should not require restarting that service or changing DNS.

Verify the public HTTPS HTML, language/title, hashed assets and their content hashes, compression, health endpoint, and unchanged backend/service identity. Keep the previous asset directory for rollback. Browser and real-wallet acceptance remain separate from static deployment proof.

## References

- [NEAR Intents React integration](https://docs.near-intents.org/integration/devkit/react-widget)
- [Aurora integration packages](https://github.com/aurora-is-near/intents-swap-widget)
- [Aurora API keys and fees](https://docs.intents.aurora.dev/getting-started/api-keys-and-fees)

## AI agents (MCP)

NearVerse has an optional remote MCP server for AI agents at `https://nearverse.space/mcp` (Streamable HTTP, JSON responses).

1. Open `https://nearverse.space/mcp/`, connect a NEAR wallet and sign a text message (no transaction).
2. Copy the agent token or the ready MCP client configuration. The token gives access to that account's journal only, never to the wallet; it expires after 7 days and can be revoked on the same page. The signed text says that it grants an AI agent access.
3. Set spending limits (per swap and per 24 hours, USD) before signing. Tools: `list_systems`, `list_swap_tokens`, `get_limits`, `get_swap_quote`, `verify_arrival`, `get_ship`, `set_ship`, `start_expedition`, `complete_expedition`, `read_story`, `get_journal`.
4. Systems and chapters open for the agent only after a real swap into the system's asset: the agent gets a quote, signs the single deposit transaction with its own NEAR wallet tool (NearVerse never holds keys or funds), then calls `verify_arrival`; the main server verifies the arrival as for people.

Limits are a safety rail, not custody: NearVerse refuses to prepare swaps above the owner's limits (summed per account across tokens), but an agent that can send deposits holds a key able to move all funds of that account. Give agents a separate account with a small balance.

Agent grants: the page requests the sign-in text through the module (`POST /mcp/api/challenge`), and the history server issues a 7-day agent challenge only when the request carries the shared `AGENT_LINK_SECRET` (set the same value, at least 32 characters, for both services). A browser therefore never gets a 7-day cookie, and an ordinary site sign-in cannot become an agent token. `DELETE /mcp/api/link?all=1` revokes every agent token of the account; any holder of one token can do this, which at worst cuts off that account's other agents. The MCP client must support custom headers (Bearer token); OAuth discovery is not offered.

Deployment: proxy `location = /mcp` and `location ^~ /mcp/` to the module with `proxy_set_header X-Real-IP $remote_addr;` (the module trusts that header from loopback for per-client limits; without this line clients could bypass them), and run it with `Restart=on-failure`. `HISTORY_API` must be a loopback URL.

The module is isolated from the site: it runs as its own process (`npm run mcp`, port 4320, own SQLite file `MCP_DB`, required `MCP_SECRET` = 64 hex characters, `AGENT_LINK_SECRET`) and talks to the history API only through its public HTTP contract. Stopping it does not affect the site. Build the page with `npm run build:mcp` (output `dist-mcp/`).

## License

MIT. See [LICENSE](LICENSE).
