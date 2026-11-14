# NearVerse

NearVerse is an English-language space exploration interface for real swaps through NEAR Intents. Its six asset regions contain ten systems and thirty sequential story chapters. NEAR, USDC, BTC, ETH and SOL are the main regions; USDT remains an alternative. A passage represents a swap, not a separate financial instrument or a promise of profit. After arrival, systems in the same asset region can be explored without additional swaps.

The application uses React, TypeScript and Vite, with a small Node/SQLite history backend. Aurora Intents core is pinned to 7.29.0 and the supported NEAR connector to 0.6.11. The existing standalone package remains locked for reproducibility but is not imported into the runtime. The map has an equivalent keyboard-accessible destination list, system illustrations have text descriptions, and expeditions resume from their saved timestamps.

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

Select **Isolated preview** for exploration without connecting a wallet or making swaps. Practice progress is stored only on that device and never syncs to live history. Try editing the ship, starting an expedition, reloading and completing it after its timer. Select a destination from the text list and verify that focus moves to its heading. Check keyboard navigation, narrow screens and reduced-motion settings.

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
