# NearVerse — repository guide

## Product and language

NearVerse is a React/TypeScript space-exploration interface for real NEAR Intents swaps, with a Node/Express/SQLite history backend. Six asset regions contain ten systems and thirty sequential story chapters. A passage represents a swap; it is not a separate financial instrument or a promise of rewards.

- Keep the application, built-in stories, accessibility text, errors, metadata and public documentation English-only. Do not introduce partially translated UI. Preserve user-entered ship text rather than silently translating saved data.
- Wallet accounts and signing use NEAR. BTC, ETH, SOL, USDC, USDT and wNEAR Intents assets remain supported; their presence does not require connecting wallets on those external chains. Do not present Intents balances as native-chain withdrawals.
- Arrival unlocks exploration in the corresponding asset region. Expeditions and stories do not require additional swaps or provide financial rewards. Preserve system/story IDs, ordering, asset bindings and progression when editing content.

## Repository map

- `src/main.tsx`: React entry point and StrictMode.
- `src/App.tsx`: game shell, map and accessible destination list, ship editor, expeditions, journal and mode switching.
- `src/world.ts`, `src/assets.ts`: built-in regions/stories and exact supported asset identities.
- `src/storage.ts`: account/mode-scoped IndexedDB cache, ship settings, retry queue and bounded export/import.
- `src/SystemIllustration.tsx`, `src/system-illustration.css`, `public/`: built-in artwork and accessible descriptions; `src/style.css` owns the main layout.
- `src/sdk/financialActivation.ts`, `recoveryProbe.ts`: lightweight activation and startup recovery observation; these belong outside the eager financial dependency graph.
- `src/sdk/FinancialPanel.tsx`, `NearWalletProvider.tsx`: financial boundary and supported NEAR-only connector/provider composition.
- `src/sdk/HeadlessConverter.tsx`: real SDK lifecycle, quotes, consent, pending recovery, history sign-in and verified arrivals.
- `src/sdk/signing.ts`, `safety.ts`: guarded wallet calls, amounts, quote binding, reserves and the duplicate-signature operation ledger.
- `src/sdk/material-icons.mjs`, `vite.config.ts`: exact icon-leaf alias and build/test dependency handling.
- `server/index.ts`: loopback server and backup/restore entry point; `app.ts`: testable HTTP factory; `auth.ts`: ownership/session verification; `store.ts`: SQLite; `upstream.ts`: real arrival verification; `world.ts`: world adapter; `frontend.ts`: static-serving policy.
- `tests/`: UI/storage/history, real SDK composition and lifecycle, financial guards, HTTP/SQLite and frontend-policy tests. `scripts/` contains icon checks and prepared browser/HTTP QA helpers.
- `dist/` is generated output. `data/` contains private runtime data and local evidence, not public web content. `plan.md` is local task context, not a source of public credentials or material to publish wholesale.

## Installation and validation

Use Node 22 and npm 10. Preserve the committed `.npmrc`, exact dependency pins, overrides and `package-lock.json`; do not patch `node_modules` or replace peer-resolution policy with ad-hoc flags.

Run dependency installation, Node-based QA, tests, dev/preview servers and builds only on an authorised isolated development/build machine, not the shared assistant host or a shared production server. Bound the entire process tree's memory and CPU before execution; the build's JavaScript heap limit is not a total memory limit.

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run test:icons
npm run build
```

`npm test` uses one Vitest worker. `npm run build` typechecks and produces default-minified Vite output in `dist/`; do not disable minification to declare a production build complete. Native SQLite installation may require Python and a C/C++ toolchain. The icon alias must continue to resolve consistently in development, tests and production.

On the authorised development machine:

```sh
APP_ORIGIN=http://127.0.0.1:5173 PORT=4318 npm run server
npm run dev
```

Vite proxies `/api` to the loopback backend. `npm run preview` serves built frontend plus API on loopback port 4319. These commands are not deployment instructions. See `README.md` for setup and `server/CONTRACT.md` for the exact API contract.

## Lazy loading and wallet integration

- The first screen must expose an enabled, accessible `Connect NEAR wallet` control. One activation loads finance and opens the genuine NEAR selector; do not add a separate Load-then-Connect step or lose popup user activation across asynchronous imports.
- Keep the game shell free of eager SDK/wallet imports. The standalone multichain package may remain locked but must not re-enter the runtime graph merely for convenience. Use the supported connector and public core provider contract, not custom signers, fake crypto or empty dependency aliases.
- Once activated, preserve the financial provider/store and pending callback context across beacon, viewport and preview changes. Preview must remove signing capability without destroying an unresolved wallet operation.
- Recovery observation must remain monotonic across both lazy boundaries and render/effect transitions. Preserve first-seen raw records; denied/corrupt storage, malformed owners and disappeared/replaced records fail closed. Use prototype-safe dictionaries.
- Transfer observation ownership only after live listeners are installed and the converter accepts the final combined snapshot. An absent/restoring account or a newly observed pending record is not acceptance. Legitimate server-confirmed recovery/removal after handoff must still allow a new quote with fresh consent.

## Financial and history invariants

- Match exact asset IDs and custody layers, never symbols alone. Keep UI-native and upstream asset normalization in the existing adapters. Use smallest-unit strings/BigInt, not floating-point transaction amounts.
- Each financial operation requires explicit scoped authorisation and a fresh quote bound to the account, source/destination, amounts, minimum output, receiver, deadline and displayed fees. Build/test success is not spending permission.
- Recheck revocation and identity before and after awaited wallet calls. Changing conditions, switching accounts/preview or unmounting invalidates stale permission; checking consent again must not revive the old attempt. A wallet call already sent cannot be cancelled by changing UI state.
- Persist recovery before signing. Unknown/pending outcomes block another transfer. Reconcile rather than replay after timeout/reload. Do not erase recovery, reset budget ledgers or release reserves by hand to make a test pass.
- The site imposes no account allowlist or amount/fee cap: any NEAR account may swap any amount it explicitly approves. Spending limits belong to the user or the agent operating the site. Preserve gas/storage reserves, the duplicate-signature ledger and account-level Web Locks.
- A signed message, key registration or submitted deposit is not a completed swap. Live arrival requires independent final upstream verification and exact operation binding by the backend.
- History requires separate NEP-413 ownership authentication. Connecting an address is not authentication. Preserve Origin/account/nonce/expiry/access-key checks, cookie ownership and journal-revision fencing.
- Preview data never confirms live arrivals. Live imports may change local ship settings, not verified history. Ship text stays plain text; retain bounded same-account/mode JSON import and built-in art rather than arbitrary uploads.

## Data, deployment and evidence

- Build-time `VITE_AURORA_API_KEY` is public client configuration. No password, seed, private key or partner secret belongs in `VITE_*`. Missing configuration must block live finance, not substitute fixture quotes. Transfer only explicitly required public build configuration, never an entire environment file.
- Backend settings are `APP_ORIGIN`, `PORT`, `HISTORY_DB`; retain loopback binding, exact Origin validation and HTTPS cookie policy. Do not use permissive CORS, weaken CSP or enable `unsafe-eval` to hide integration failures.
- Use SQLite's online backup API for a running WAL database. Restore into a new validated destination and revoke sessions as implemented; never overwrite an open DB or discard WAL/SHM. Keep backups outside public roots.
- For frontend-only updates, transfer the reviewed, hash-manifested `dist/` from the isolated builder, back up existing assets, then swap atomically. Preserve backend generation, private configuration, DB/session state, WAL/SHM, logs and neighbouring sites. A deployed backend may contain operational logging absent from this checkout: never overwrite it as part of an assets-only release.
- Verify public HTTPS assets/hashes, compression, language/title, health and protected runtime continuity. Keep rollback assets and consider old open tabs that may still request previous lazy chunks. Do not repeat an uncertain atomic swap blindly.
- Offline mocks, controlled signers and rendered Meteor login/cancellation do not prove authenticated or funded acceptance. Record actual balances/receipts, final provider result, server arrival, UI and reload persistence separately. Interactive wallet QA uses only the authorised browser/account and sufficient resource headroom; do not stop other tasks or change shared limits to force admission.
- Keep this file public-safe: no wallet/account identifiers, transaction/deposit IDs, credentials, cookies, signed URLs, hosting addresses, chat IDs or private operational history. `.env*`, `data/`, logs, browser profiles and operational evidence must not be committed or published.

## Coupled changes

Update corresponding behavioral tests when changing recovery, consent, signing, storage schemas, authentication, event verification or frontend serving. Content changes must preserve world/asset/server-adapter consistency and accessible labels. Update `README.md`, `server/CONTRACT.md` and `DEPENDENCY-SECURITY.md` when their documented contracts actually change; do not replace live verification with historical test counts.
