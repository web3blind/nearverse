// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyArrival } from '../server/upstream';
import { depositTransaction } from '../mcp/tools';

// The deposit the MCP tells an agent to sign must pass the unchanged main-server arrival check.
const owner = 'agent.near'; const depositAddress = 'a'.repeat(64);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
type Action = { type: string; methodName?: string; args?: unknown; gas?: string; deposit: string };
const rpcAction = (a: Action) => a.type === 'Transfer' ? { Transfer: { deposit: a.deposit } } : { FunctionCall: { method_name: a.methodName, args: b64(a.args), gas: Number(a.gas), deposit: a.deposit } };

function stub(originAsset: string, amountIn: string, tx: { receiverId: string; actions: Action[] }) {
  const hash = '4'.repeat(44);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const body = String(url).includes('1click')
      ? { status: 'SUCCESS', quoteResponse: { quoteRequest: { recipientType: 'INTENTS', refundTo: owner, recipient: owner, originAsset, destinationAsset: 'nep141:usdt.tether-token.near', depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN' },
          quote: { amountIn, amountOut: '1000', minAmountOut: '990', depositAddress } }, swapDetails: { amountIn, amountOut: '1000', originChainTxHashes: [{ hash }] } }
      : { jsonrpc: '2.0', id: 'arrival', result: { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: { hash, signer_id: owner, receiver_id: tx.receiverId, actions: tx.actions.map(rpcAction) } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}
const proof = (originAsset: string, amountIn: string) => ({ depositAddress, originAsset, destinationAsset: 'nep141:usdt.tether-token.near', amountIn, amountOut: '1000', minAmountOut: '990' });
const target = { systemId: 'usdt-harbor', assetId: 'nep141:usdt.tether-token.near' };
afterEach(() => { vi.unstubAllGlobals(); });

describe('MCP deposit instructions', () => {
  it('produce a token deposit the arrival verifier accepts', async () => {
    const d = depositTransaction('nep141:wrap.near', depositAddress, '5') as unknown as { alternative: { receiverId: string; actions: Action[] } };
    const usdc = depositTransaction('nep141:usdc.example.near', depositAddress, '1500000') as unknown as { transaction: { receiverId: string; actions: Action[] } };
    stub('nep141:usdc.example.near', '1500000', usdc.transaction);
    expect(await verifyArrival(owner, target, proof('nep141:usdc.example.near', '1500000'))).toBe(true);
    stub('nep141:wrap.near', '5', d.alternative);
    expect(await verifyArrival(owner, target, proof('nep141:wrap.near', '5'))).toBe(true);
  });
  it('produce a native NEAR deposit the arrival verifier accepts, and a memo breaks it', async () => {
    const d = depositTransaction('nep141:wrap.near', depositAddress, '100000000000000000000000') as unknown as { preferred: { receiverId: string; actions: Action[] } };
    stub('nep141:wrap.near', '100000000000000000000000', d.preferred);
    expect(await verifyArrival(owner, target, proof('nep141:wrap.near', '100000000000000000000000'))).toBe(true);
    const usdc = depositTransaction('nep141:usdc.example.near', depositAddress, '7') as unknown as { transaction: { receiverId: string; actions: Action[] } };
    const withMemo = { ...usdc.transaction, actions: usdc.transaction.actions.map(a => a.methodName === 'ft_transfer' ? { ...a, args: { ...(a.args as object), memo: 'x' } } : a) };
    stub('nep141:usdc.example.near', '7', withMemo);
    expect(await verifyArrival(owner, target, proof('nep141:usdc.example.near', '7'))).toBe(false);
  });
});
