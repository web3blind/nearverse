// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { verifyArrival, type ArrivalProof } from '../server/upstream';

const owner = 'alice.near';
const hash = 'A'.repeat(44);
const proof: ArrivalProof = { depositAddress: 'deposit.near', originAsset: 'nep141:wrap.near', destinationAsset: 'nep141:nbtc.bridge.near', amountIn: '100', amountOut: '200', minAmountOut: '190' };
const target = { systemId: 'btc-basalt', assetId: proof.destinationAsset };
function status(asset = proof.originAsset) {
  return { status: 'SUCCESS', quoteResponse: { quoteRequest: { depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', recipientType: 'INTENTS', refundTo: owner, recipient: owner, originAsset: asset, destinationAsset: proof.destinationAsset }, quote: { ...proof } }, swapDetails: { amountIn: '100', amountOut: '200', originChainTxHashes: [{ hash, explorerUrl: 'https://untrusted.invalid' }] } };
}
type FixtureAction={FunctionCall?:{method_name:string;args:string;deposit:string;gas:number};Transfer?:{deposit:string}};
function transaction(ft = false, storage = false) {
  const call = (method_name: string, args: unknown, deposit: string) => ({ FunctionCall: { method_name, args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit, gas: 50000000000000 } });
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: { hash, signer_id: owner, receiver_id: ft ? 'wrap.near' : proof.depositAddress, actions: (ft ? [...(storage ? [call('storage_deposit', { account_id: proof.depositAddress }, '125')] : []), call('ft_transfer', { receiver_id: proof.depositAddress, amount: proof.amountIn }, '1')] : [{ Transfer: { deposit: proof.amountIn } }]) as FixtureAction[] } };
}
function setup(s = status(), tx = transaction()) {
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({})));
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(s))).mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'arrival', result: tx })));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
it.each([false, true])('proves owned native / NEP-141 NEAR deposit via read-only final tx (ft=%s)', async ft => {
  const fetcher = setup(status(), transaction(ft));
  expect(await verifyArrival(owner, target, proof)).toBe(true);
  expect(fetcher.mock.calls).toHaveLength(2);
  const calls = fetcher.mock.calls as unknown as [string | URL, RequestInit][];
  expect(calls[1][0]).toBe('https://rpc.mainnet.near.org');
  expect(JSON.parse(calls[1][1].body as string)).toMatchObject({ method: 'tx', params: { tx_hash: hash, sender_account_id: owner, wait_until: 'FINAL' } });
  expect(calls[1][1].redirect).toBe('error');
});
it('accepts SDK optional storage registration and another NEAR NEP-141 contract', async () => {
  const asset = 'nep141:usdt.tether-token.near'; const tx = transaction(true, true); tx.transaction.receiver_id = 'usdt.tether-token.near';
  setup(status(asset), tx); expect(await verifyArrival(owner, target, { ...proof, originAsset: asset })).toBe(true);
});
it.each(['signer', 'receiver', 'amount', 'failure', 'not-final', 'hash', 'extra-action', 'ft-receiver', 'ft-amount', 'ft-contract', 'ft-deposit', 'ft-method', 'ft-args'])('rejects wrong transaction evidence: %s', async kind => {
  const tx = transaction(kind.startsWith('ft-'));
  if (kind === 'signer') tx.transaction.signer_id = 'bob.near';
  if (kind === 'receiver') tx.transaction.receiver_id = 'other.near';
  if (kind === 'amount') tx.transaction.actions = [{ Transfer: { deposit: '99' } }];
  if (kind === 'failure') tx.status = { Failure: {} } as never;
  if (kind === 'not-final') tx.final_execution_status = 'EXECUTED';
  if (kind === 'hash') tx.transaction.hash = 'B'.repeat(44);
  if (kind === 'extra-action') tx.transaction.actions.push({ Transfer: { deposit: '1' } });
  if (kind === 'ft-contract') tx.transaction.receiver_id = 'other.near';
  const action = tx.transaction.actions[0] as { FunctionCall?: { args: string; deposit: string; method_name: string } };
  if (kind === 'ft-receiver') action.FunctionCall!.args = Buffer.from(JSON.stringify({ receiver_id: 'other.near', amount: '100' })).toString('base64');
  if (kind === 'ft-amount') action.FunctionCall!.args = Buffer.from(JSON.stringify({ receiver_id: proof.depositAddress, amount: '99' })).toString('base64');
  if (kind === 'ft-deposit') action.FunctionCall!.deposit = '0';
  if (kind === 'ft-method') action.FunctionCall!.method_name = 'ft_transfer_call';
  if (kind === 'ft-args') action.FunctionCall!.args = 'not base64';
  setup(status(), tx); expect(await verifyArrival(owner, target, proof)).toBe(false);
});
it.each(['status', 'refund', 'refund-type', 'recipient', 'recipient-type', 'asset', 'amount', 'output', 'deposit', 'memo', 'missing-hashes', 'multiple-hashes', 'unsupported-chain', 'native-alias'])('rejects unbound/unsupported upstream evidence: %s', async kind => {
  const s = status(); const req = s.quoteResponse.quoteRequest;
  if (kind === 'status') s.status = 'REFUNDED';
  if (kind === 'refund') req.refundTo = 'bob.near';
  if (kind === 'refund-type') req.refundType = 'INTENTS';
  if (kind === 'recipient') req.recipient = 'bob.near';
  if (kind === 'recipient-type') req.recipientType = 'DESTINATION_CHAIN';
  if (kind === 'asset') req.destinationAsset = 'other';
  if (kind === 'amount') s.swapDetails.amountIn = '99';
  if (kind === 'output') s.swapDetails.amountOut = '1';
  if (kind === 'deposit') s.quoteResponse.quote.depositAddress = 'other.near';
  if (kind === 'memo') s.quoteResponse.quote.depositMemo = 'required-memo';
  if (kind === 'missing-hashes') s.swapDetails.originChainTxHashes = [];
  if (kind === 'multiple-hashes') s.swapDetails.originChainTxHashes.push({ hash: 'B'.repeat(44), explorerUrl: '' });
  if (kind === 'unsupported-chain') req.originAsset = 'nep245:eth.omft.near:1';
  if (kind === 'native-alias') req.originAsset = 'native:near';
  setup(s); expect(await verifyArrival(owner, target, kind === 'unsupported-chain' || kind === 'native-alias' ? { ...proof, originAsset: req.originAsset } : proof)).toBe(false);
});
it.each(['oversized-header', 'oversized-stream', 'invalid-json', 'rpc-error', 'missing-result', 'missing-final-success', 'string-hash'])('fails closed on malformed or excessive response: %s', async kind => {
  const s = status();
  const fetcher = setup(s);
  if (kind === 'string-hash') { (s.swapDetails.originChainTxHashes as unknown[]) = [hash]; fetcher.mockReset().mockResolvedValueOnce(new Response(JSON.stringify(s))); }
  else {
    let response: Response;
    if (kind === 'oversized-header') response = new Response('{}', { headers: { 'content-length': '65537' } });
    else if (kind === 'oversized-stream') response = new Response(' '.repeat(65537));
    else if (kind === 'invalid-json') response = new Response('{');
    else if (kind === 'rpc-error') response = new Response(JSON.stringify({ jsonrpc: '2.0', id: 'arrival', error: { message: 'unknown transaction' } }));
    else if (kind === 'missing-result') response = new Response(JSON.stringify({ jsonrpc: '2.0', id: 'arrival' }));
    else { const tx = transaction(); tx.status = {} as never; response = new Response(JSON.stringify({ jsonrpc: '2.0', id: 'arrival', result: tx })); }
    fetcher.mockReset().mockResolvedValueOnce(new Response(JSON.stringify(s))).mockResolvedValueOnce(response);
  }
  expect(await verifyArrival(owner, target, proof)).toBe(false);
});
it('rejects native deposit with memo and synthetic quote assets even when bound', async () => {
  setup(); expect(await verifyArrival(owner, target, { ...proof, depositMemo: 'memo' })).toBe(false);
  for (const asset of ['native-near', 'native:near', 'native:eth']) {
    setup(status(asset)); expect(await verifyArrival(owner, target, { ...proof, originAsset: asset })).toBe(false);
  }
});
it('aborts a stalled origin RPC under the shared five-second deadline', async () => {
  const fetcher = setup();
  fetcher.mockReset().mockResolvedValueOnce(new Response(JSON.stringify(status()))).mockImplementationOnce((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  expect(await verifyArrival(owner, target, proof)).toBe(false);
}, 10000);
it('preserves account-bound Intents flow without an origin RPC request', async () => {
  const s = status(); s.quoteResponse.quoteRequest.depositType = 'INTENTS'; s.quoteResponse.quoteRequest.refundType = 'INTENTS'; s.swapDetails.originChainTxHashes = [];
  const fetcher = setup(s); expect(await verifyArrival(owner, target, proof)).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
});
