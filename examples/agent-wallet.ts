// Minimal NEAR wallet tool for an AI agent playing NearVerse over MCP.
// The key stays on the agent's machine; NearVerse never sees it.
//
//   NEAR_KEY_FILE=key.json npx tsx examples/agent-wallet.ts link 1 2      # sign in, print agent token (limits: $1 per swap, $2 per day)
//   NEAR_KEY_FILE=key.json npx tsx examples/agent-wallet.ts send '<deposit JSON from get_swap_quote>'
//   NEAR_KEY_FILE=key.json npx tsx examples/agent-wallet.ts balance
//
// key.json: {"account_id": "...", "private_key": "ed25519:..."}
import { readFileSync } from 'node:fs';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { actionCreators, createTransaction, Signature, SignedTransaction, encodeTransaction } from '@near-js/transactions';
import { baseDecode } from '@near-js/utils';
import { createHash } from 'node:crypto';
import { nep413Hash, type Challenge } from '../server/auth';

const SITE = process.env.NEARVERSE_URL || 'https://nearverse.space';
const RPC = process.env.NEAR_RPC || 'https://rpc.mainnet.near.org';
const key = JSON.parse(readFileSync(process.env.NEAR_KEY_FILE || 'key.json', 'utf8')) as { account_id: string; private_key: KeyPairString };
const pair = KeyPair.fromString(key.private_key); const account = key.account_id;
const rpc = new JsonRpcProvider({ url: RPC });
// The history API accepts browser-style requests only from its own origin.
const JSON_HEADERS = { 'Content-Type': 'application/json', Origin: new URL(SITE).origin };

interface Action { type: 'Transfer' | 'FunctionCall'; deposit: string; methodName?: string; args?: Record<string, unknown>; gas?: string }
interface Deposit { receiverId: string; actions: Action[] }

async function link(perSwapUsd: number, dailyUsd: number) {
  const res = await fetch(SITE + '/mcp/api/challenge', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ accountId: account }) });
  const challenge = await res.json() as Challenge & { error?: string }; if (!res.ok || !challenge.id) throw new Error(`challenge refused: ${challenge.error ?? res.status}`);
  const signature = Buffer.from(pair.sign(nep413Hash(challenge)).signature).toString('base64');
  const r = await fetch(SITE + '/mcp/api/link', { method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ challengeId: challenge.id, accountId: account, publicKey: pair.getPublicKey().toString(), signature, limits: { perSwapUsd, dailyUsd } }) });
  const data = await r.json(); if (!r.ok) throw new Error(`link refused: ${data.error}`);
  return data;
}

async function send(deposit: Deposit) {
  // Refuse anything but the two shapes NearVerse issues: one native transfer, or storage_deposit + ft_transfer.
  const shape = deposit.actions.map(a => a.type === 'Transfer' ? 'Transfer' : a.methodName).join(',');
  if (!['Transfer', 'ft_transfer', 'storage_deposit,ft_transfer'].includes(shape)) throw new Error('unexpected deposit shape: ' + shape);
  const access = await rpc.viewAccessKey(account, pair.getPublicKey(), { finality: 'final' });
  const block = await rpc.viewBlock({ finality: 'final' });
  const actions = deposit.actions.map(a => a.type === 'Transfer' ? actionCreators.transfer(BigInt(a.deposit))
    : actionCreators.functionCall(a.methodName!, a.args!, BigInt(a.gas ?? '30000000000000'), BigInt(a.deposit)));
  const tx = createTransaction(account, pair.getPublicKey(), deposit.receiverId, BigInt(access.nonce) + 1n, actions, baseDecode(block.header.hash));
  const hash = createHash('sha256').update(encodeTransaction(tx)).digest();
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: pair.sign(hash).signature }) });
  const outcome = await rpc.sendTransactionUntil(signed, 'FINAL');
  return { hash: outcome.transaction.hash, status: Object.keys(outcome.status as object)[0] };
}

const [cmd, a, b] = process.argv.slice(2);
const run = cmd === 'link' ? link(Number(a ?? 1), Number(b ?? 2))
  : cmd === 'send' ? send(JSON.parse(a))
  : cmd === 'balance' ? rpc.query({ request_type: 'view_account', account_id: account, finality: 'final' }).then((v: any) => ({ account, near: Number(BigInt(v.amount) / 10n ** 18n) / 1e6 }))
  : Promise.reject(new Error('usage: link <perSwapUsd> <dailyUsd> | send <deposit JSON> | balance'));
run.then(r => console.log(JSON.stringify(r))).catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
