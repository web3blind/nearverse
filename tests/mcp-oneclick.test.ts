// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oneClick } from '../mcp/oneclick';

const input = { originAsset: 'nep141:wrap.near', destinationAsset: 'nep141:usdt.tether-token.near', amount: '100000000000000000000000', owner: 'alice.near', deadline: '2030-01-01T00:00:00.000Z' };
function reply(quote: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ quote: { amountIn: input.amount, amountInUsd: '0.313', amountOutUsd: '0.312', depositAddress: 'a'.repeat(64), ...quote },
    quoteRequest: { dry: false, swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', recipientType: 'INTENTS', recipient: 'alice.near', refundTo: 'alice.near', originAsset: input.originAsset, destinationAsset: input.destinationAsset } }), { status: 201 })));
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('1Click quote validation', () => {
  it('accepts the 1% minimum rounded down by one unit, as returned live', async () => {
    reply({ amountOut: '312270', minAmountOut: '309147' });
    await expect(oneClick().quote(input)).resolves.toMatchObject({ minAmountOut: '309147' });
  });
  it('refuses a minimum wider than the requested 1% slippage', async () => {
    reply({ amountOut: '312270', minAmountOut: '300000' });
    await expect(oneClick().quote(input)).rejects.toMatchObject({ code: 'intents_unexpected_slippage' });
  });
});
