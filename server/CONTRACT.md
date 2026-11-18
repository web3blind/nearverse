# History backend contract

`createApp(options)` in `server/app.ts` is the testable Express factory. `origin` is required and is the exact canonical browser origin; injected clock/ownership/arrival verifiers are dependency injection only, never environment bypasses. Default verifiers use official NEAR public-key verification / final access-key RPC and the actual 1Click status endpoint. `systems` and `homeSystemId` default to the adapter over `src/world.ts` (`near-lada` is the starting system). Stories require the previous story to be read.

Run `npm run server`: loopback `127.0.0.1:4318`, matching Vite's proxy; default allowed browser origin `http://127.0.0.1:5173`. Set `APP_ORIGIN` explicitly for a different host/port. `HISTORY_DB` defaults to `data/history.sqlite`. Non-loopback origins require HTTPS; HTTPS sessions use Secure `__Host-nearverse`, local HTTP uses `nearverse`. No CORS is enabled. Use same-origin `/api` requests with cookies and `X-Nearverse-Account` set to the wallet account expected by this tab; a mismatch against cookie ownership returns 409 `account_changed`. All mutations require JSON and the exact Origin header. Error bodies are `{error: string}`.

## Auth (no financial transaction)

- `GET /api/health` → `{ok:true}`.
- `POST /api/auth/challenge` `{accountId, purpose?: 'agent'}` → `{id,accountId,message,nonce,recipient,expiresAt}`. `nonce` is base64 encoding of exactly 32 bytes; `recipient` is the configured origin's host. Expiry is server epoch milliseconds (5 minutes). `purpose: 'agent'` is accepted only with header `X-NearVerse-Agent-Link` equal to the `AGENT_LINK_SECRET` the server was started with (else 403 `agent_link_only`); its message says it grants an AI agent access for 7 days.
- Have the existing wallet sign the exact NEP-413 message / nonce / recipient, **without callbackUrl**. Do not sign a transfer or ask for a private key.
- `POST /api/auth/verify` `{challengeId,accountId,publicKey,signature}`; signature is canonical base64 of 64-byte Ed25519 signature. Response `{accountId,expiresAt}` sets HttpOnly, SameSite=Strict cookie (24 hours; 7 days for an agent challenge, which also needs the agent-link header). The response also has `purpose`: `site` or `agent`. Restricted function-call access keys are not accepted as whole-account ownership. Challenges are consumed on the first verification attempt, including failure.
- `GET /api/auth/session` → `{accountId,expiresAt}` or `{accountId:null}`.
- `POST /api/auth/logout` `{}` → `{ok:true}`, revokes the presented cookie.

## Game journal

`POST /api/events` accepts exactly `{eventId,type,systemId,storyId?,proof?}`. Owner and time are derived by the server; status, owner/accountId, financial fields outside proof, arbitrary metadata, preview flags, and client time are rejected. IDs match `[A-Za-z0-9_-]{1,100}`.

Types:
- `arrival`: `systemId`, no `storyId`, required `proof` below. No history is written unless upstream verification succeeds. Use the same eventId for retry; rejected/pending arrival remains a client-side pending operation, not a fabricated successful event.
- `expedition.started`: `systemId,storyId`; requires an arrival in the same asset region (there is no free home region; `homeSystemId` defaults to empty), predecessor read, and no other active expedition. Response includes server `readyAt`.
- `expedition.completed`: same IDs, requires matching start and server time >= readyAt.
- `story.read`: same IDs, requires completion.

`proof` is exactly `{depositAddress,depositMemo?,originAsset,destinationAsset,amountIn,amountOut,minAmountOut}`. Amounts are positive integer strings (up to 78 digits). **Do not send accountId in the event:** the authenticated session supplies ownership. The production verifier requires final `SUCCESS`, matching quote deposit address/memo, both recipient and refundTo equal session account, INTENTS recipient type, exact source/destination assets and quote amounts/minimum, actual settled amounts meeting the minimum, and the destination system's canonical asset. INTENTS sources also require INTENTS refund type. ORIGIN_CHAIN sources require ORIGIN_CHAIN refund type plus a fixed-endpoint NEAR `tx` lookup proving FINAL success, exact transaction hash, owner signer, and an exact native Transfer or NEP-141 ft_transfer to the deposit address (optional preceding SDK-style storage_deposit). Split deposits, custom/relayed action sets and origin memos are not supported. The SDK synthetic UI asset is exactly `native-near`; its upstream quote asset is `nep141:wrap.near`, never `native:near`. Any missing/unsupported response fails closed. No transaction is submitted; proof/amounts/deposit addresses are not stored. Only a digest of the operation is retained for replay protection, plus game event data.

Current world asset IDs: NEAR=`nep141:wrap.near`, BTC=`nep141:nbtc.bridge.near`, ETH=`nep141:eth.omft.near`, USDT=`nep141:usdt.tether-token.near`. Unsupported representations/routes do not automatically qualify.

Response `{event:{seq,eventId,type,systemId,storyId?,createdAt,readyAt?}}`: HTTP 201 new, 200 exact retry; 409 changed eventId payload/order/duplicate operation/unverified arrival, 503 verifier unavailable. Exact retry of an already recorded arrival doesn't call upstream again.

- `GET /api/events` → `{events:[...]}` in server sequence order, exclusively current owner.
- `GET /api/journal` → attachment `{version:1,accountId,events:[...]}`. Export is not a signed receipt and there is deliberately no unauthenticated import API.
- `DELETE /api/journal` JSON `{}` → `{ok:true}`, deletes only current owner's game journal and increments its durable revision. Requests already awaiting upstream cannot recreate deleted events: they return 409 `journal_deleted`. The UI records a separate local deletion marker so pending financial recovery does not reintroduce an arrival after deletion. Existing backups are not remotely rewritten.

Limits: 8 KiB JSON body, 120 requests/minute per direct peer IP, 1,000 outstanding challenges globally, 10,000 events per owner, 5-second verifier deadlines. No trust-proxy is enabled; a future reverse proxy must explicitly provide a safe deployment-specific rate-limit identity before public use. These are MVP local-process limits, not distributed abuse protection. NEAR provider RPC requests have bounded HTTP-handler deadlines but the installed official provider does not expose cancellation of its underlying fetch. Arrival status fetch is aborted at 5 seconds and capped at 64 KiB. All API responses are no-store. No request bodies/signatures are logged.

## Ship profile
- `GET /api/ship` (session) → `{ship:{name,biography,art,updatedAt}|null}`.
- `PUT /api/ship` (session, same-origin JSON) `{name,biography,art}` → `{ship}`. name 1–60 chars, one line; biography ≤ 2000 chars; art `courier|surveyor|sail`; control characters rejected (400 `invalid_ship`). One ship per account; deleting the journal keeps the ship.
- Optional public copy: the player's own wallet calls `social.near` `set` for `<account>/nearverse/ship` with a refundable storage deposit (first write registers 0.02 NEAR of storage). NearVerse never signs it and runs no contract.

## SQLite maintenance

Use a private destination directory. DB files are chmod 0600; runtime data directory is 0700. Schema version 2 adds journal revision fencing; version 1 backups remain accepted and migrate on subsequent open. Backup includes authentication tables, whose session IDs are hashed, and no signatures; retain backups with limited access and explicit retention.

- `npx tsx server/index.ts backup /private/path/new-backup.sqlite` uses the SQLite online backup API, verifies integrity, refuses an existing destination.
- Stop the application before switching restored databases. `npx tsx server/index.ts restore /private/path/backup.sqlite /private/path/new-history.sqlite` validates schema version/integrity, creates a new database, and removes all sessions/challenges. Set `HISTORY_DB` to the restored path when restarting. Never copy a live database file over an open SQLite connection.

Coverage uses real Express HTTP, SQLite, official NEAR offline fixture signatures, injected ownership/arrival boundaries, and independently mocked production-verifier HTTP. No real wallet, transfer, production deployment, or live completed swap has been exercised. This slice is not whole-MVP acceptance.
