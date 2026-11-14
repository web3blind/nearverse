import type { FinalExecutionOutcome } from '@near-js/types';

export interface ArrivalProof { depositAddress: string; depositMemo?: string; originAsset: string; destinationAsset: string; amountIn: string; amountOut: string; minAmountOut: string }
export interface ArrivalTarget { systemId: string; assetId: string }
export type ArrivalVerifier = (owner: string, target: ArrivalTarget, proof: ArrivalProof) => Promise<boolean>;
const NEAR_RPC = 'https://rpc.mainnet.near.org';
const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value);
const account = (value: string) => value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);

// Raw official JSON-RPC wire format keeps response streaming bounded (the provider's
// automatic JSON decode has no size cap). No caller-supplied endpoints or redirects.
async function readJson(url: string | URL, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal, redirect: 'error', headers: { Accept: 'application/json', ...init.headers } });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 65536) throw new Error('upstream_response');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('upstream_body');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 65536) throw new Error('upstream_size'); chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function functionArgs(action: Record<string, any>, method: string) {
  if (!action || Object.keys(action).length !== 1 || action.FunctionCall?.method_name !== method) return null;
  const encoded = action.FunctionCall.args;
  if (typeof encoded !== 'string' || encoded.length > 2048 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const args = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  return args && typeof args === 'object' && !Array.isArray(args) ? args : null;
}

async function verifyNearDeposit(owner: string, proof: ArrivalProof, hashes: unknown, signal: AbortSignal): Promise<boolean> {
  // SDK 7.29.0 uses native-near only as a synthetic UI token; useMakeQuote
  // maps it to nep141:wrap.near. The same quote asset supports either actual
  // native Transfer or an ft_transfer of wNEAR; native:near is NOT an alias.
  const contract = proof.originAsset.startsWith('nep141:') ? proof.originAsset.slice(7) : '';
  if (!account(owner) || !account(contract) || !account(proof.depositAddress) || proof.depositMemo) return false;
  // Only one ordinary SDK deposit, not split deposits, relayed calls or batches.
  if (!Array.isArray(hashes) || hashes.length !== 1) return false;
  const hash = hashes[0]?.hash;
  if (typeof hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) return false;
  const envelope = await readJson(NEAR_RPC, signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'arrival', method: 'tx', params: { tx_hash: hash, sender_account_id: owner, wait_until: 'FINAL' } }) });
  if (envelope.error || envelope.jsonrpc !== '2.0' || envelope.id !== 'arrival') return false;
  const result = envelope.result as FinalExecutionOutcome | undefined;
  if (result?.final_execution_status !== 'FINAL' || typeof result.status !== 'object' || result.status === null
    || Object.keys(result.status).length !== 1 || typeof result.status.SuccessValue !== 'string') return false;
  const tx = result.transaction;
  if (!tx || tx.hash !== hash || tx.signer_id !== owner || !Array.isArray(tx.actions)) return false;
  if (contract === 'wrap.near' && tx.receiver_id === proof.depositAddress && tx.actions.length === 1) {
    const action = tx.actions[0];
    return !!action && Object.keys(action).length === 1 && action.Transfer?.deposit === proof.amountIn;
  }
  if (tx.receiver_id !== contract || tx.actions.length < 1 || tx.actions.length > 2) return false;
  if (tx.actions.length === 2) {
    const storage = functionArgs(tx.actions[0], 'storage_deposit');
    if (!storage || storage.account_id !== proof.depositAddress || Object.keys(storage).length !== 1 || !positive(tx.actions[0].FunctionCall.deposit)) return false;
  }
  const action = tx.actions.at(-1);
  const args = functionArgs(action, 'ft_transfer');
  return !!args && Object.keys(args).length === 2 && args.receiver_id === proof.depositAddress
    && args.amount === proof.amountIn && action.FunctionCall.deposit === '1';
}

export const verifyArrival: ArrivalVerifier = async (owner, target, proof) => {
  try {
    if (!positive(proof.amountIn) || !positive(proof.amountOut) || !positive(proof.minAmountOut)
      || typeof proof.depositAddress !== 'string' || proof.depositAddress.length > 256
      || (proof.depositMemo !== undefined && (typeof proof.depositMemo !== 'string' || proof.depositMemo.length > 256))) return false;
    // One shared deadline covers status, its body, and origin-chain verification.
    const signal = AbortSignal.timeout(5000);
    const url = new URL('https://1click.chaindefuser.com/v0/status');
    url.searchParams.set('depositAddress', proof.depositAddress);
    if (proof.depositMemo) url.searchParams.set('depositMemo', proof.depositMemo);
    const result = await readJson(url, signal);
    const request = result?.quoteResponse?.quoteRequest;
    const quote = result?.quoteResponse?.quote;
    const details = result?.swapDetails;
    if (!(result?.status === 'SUCCESS' && request?.recipientType === 'INTENTS'
      && request.refundTo === owner && request.recipient === owner
      && request.originAsset === proof.originAsset && request.destinationAsset === proof.destinationAsset
      && request.destinationAsset === target.assetId && quote?.amountIn === proof.amountIn
      && quote.amountOut === proof.amountOut && quote.minAmountOut === proof.minAmountOut
      && positive(details?.amountIn) && details.amountIn === proof.amountIn
      && positive(details?.amountOut) && BigInt(details.amountOut) >= BigInt(proof.minAmountOut)
      && quote.depositAddress === proof.depositAddress
      && (quote.depositMemo || '') === (proof.depositMemo || ''))) return false;
    if (request.depositType === 'INTENTS') return request.refundType === 'INTENTS';
    if (request.depositType !== 'ORIGIN_CHAIN' || request.refundType !== 'ORIGIN_CHAIN') return false;
    return await verifyNearDeposit(owner, proof, details.originChainTxHashes, signal);
  } catch { return false; }
};
