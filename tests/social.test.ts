// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readOnChainShip, shipData, shipDeposit, shipTransaction, SOCIAL_MIN_DEPOSIT } from '../src/social';

const ship = { name: 'Quiet Wanderer', biography: 'Мир.', art: 'courier' as const };
const bytes = new TextEncoder().encode(JSON.stringify(shipData('a.near', ship))).length + 400;

describe('NEAR Social ship copy', () => {
  it('registers storage on the first write and pays only missing bytes afterwards', () => {
    expect(shipDeposit('a.near', ship, null)).toBe(SOCIAL_MIN_DEPOSIT + BigInt(bytes) * 10n ** 19n);
    expect(shipDeposit('a.near', ship, { available_bytes: bytes - 10 })).toBe(10n * 10n ** 19n);
    expect(shipDeposit('a.near', ship, { available_bytes: bytes + 1 })).toBe(0n);
  });
  it('writes only the account nearverse/ship key on social.near', () => {
    const tx = shipTransaction('a.near', ship, 5n).transactions[0];
    expect(tx).toMatchObject({ signerId: 'a.near', receiverId: 'social.near' });
    expect(tx.actions[0].params).toMatchObject({ methodName: 'set', deposit: '5', args: { data: { 'a.near': { nearverse: { ship } } } } });
  });
  it('reads a public ship and ignores malformed data', async () => {
    const reply = (value: unknown) => vi.fn(async () => ({ ok: true, json: async () => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }) })) as unknown as typeof fetch;
    expect(await readOnChainShip('a.near', reply(shipData('a.near', ship)))).toEqual(ship);
    expect(await readOnChainShip('a.near', reply({ 'a.near': { nearverse: { ship: { name: 1, biography: '', art: 'courier' } } } }))).toBeNull();
    expect(await readOnChainShip('a.near', reply({}))).toBeNull();
  });
});
