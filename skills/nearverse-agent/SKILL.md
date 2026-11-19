---
name: nearverse-agent
description: Play NearVerse over MCP with real NEAR Intents swaps.
version: 1.0.0
author: Denis Skripnik (web3blind)
license: MIT
---
# NearVerse Agent Skill

Plays the NearVerse story game through its remote MCP server: swap into a star system with NEAR Intents, verify arrival, run expeditions and read chapters. It does not hold keys for you; you sign deposits with your own NEAR wallet tool.

## When to Use
- The owner asks you to explore NearVerse, travel to a system or unlock chapters.

## Prerequisites
- An agent token from https://nearverse.space/mcp/ (owner signs a text message and sets USD limits). Valid 7 days.
- A NEAR wallet tool that can sign one transaction from the owner's or agent's account, for example `examples/agent-wallet.ts` in the repository or the `near-mcp` server.
- Keep about 0.01 NEAR above the swap amount for network fees.

## How to Run
Add the MCP server: url `https://nearverse.space/mcp`, header `Authorization: Bearer <token>`.

## Quick Reference
- `list_systems`, `list_swap_tokens`, `get_limits`
- `get_swap_quote` {systemId, fromToken, amount} → `quoteId`, `signerId`, `deposit`
- `verify_arrival` {quoteId}
- `start_expedition` {systemId} → `readyAt`; then `complete_expedition`
- `read_story` {systemId, storyId}, `get_journal`
- Routes: one swap opens one system along its route (`list_systems` → `route`). Chapter 2 takes 2 hours; chapter 3 needs a return swap (`returnTripDue: true`); seasonal chapters arrive weekly.
- `get_ship`, `set_ship` {name 1-60, biography up to 2000, art courier|surveyor|sail}. Optional public copy: `agent-wallet.ts ship '<json>'` writes `<account>/nearverse/ship` on social.near (refundable deposit, about 0.02 NEAR first time).

## Procedure
1. `list_systems`; pick a closed system whose asset you do not hold.
2. `get_swap_quote` with a small amount within `get_limits`.
3. Check `signerId` is your account and amounts match. Send `deposit.preferred` (wNEAR) or `deposit.transaction` exactly once.
4. Poll `verify_arrival` every 15 seconds until `arrived: true`.
5. `start_expedition`, wait past `readyAt`, `complete_expedition`; report the chapter.

## Pitfalls
- Never send a deposit twice or reuse a deposit address; if unsure, call `verify_arrival`.
- A memo, split amount or `ft_transfer_call` makes the arrival unverifiable.
- "busy" errors mean wait about a minute; nothing is lost.
- Limits stop NearVerse from preparing large swaps, not what your key can sign. Use a small dedicated account.

## Verification
`get_journal` shows `arrival`, `expedition.started`, `expedition.completed`, `story.read` for the system.
