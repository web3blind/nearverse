// Optional public copy of the ship in NEAR Social (social.near). The player pays a refundable
// storage deposit; NearVerse runs no contract of its own. Reads are free view calls.
import type { Ship } from './storage';

export const SOCIAL_CONTRACT = 'social.near';
const RPC = 'https://free.rpc.fastnear.com';
const YOCTO_PER_BYTE = 10n ** 19n;
/** social.near storage_balance_bounds().min: registering an account reserves 2000 bytes. */
export const SOCIAL_MIN_DEPOSIT = 20_000_000_000_000_000_000_000n;
/** Per-key bookkeeping overhead in SocialDB plus a safety margin. */
const OVERHEAD_BYTES = 400;
export const SHIP_GAS = '30000000000000';

async function view<T>(method: string, args: object, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'social', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: SOCIAL_CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) } }) });
  const data = await response.json();
  if (!response.ok || data.error || !Array.isArray(data.result?.result)) throw new Error('NEAR Social is unavailable. Try again later.');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(data.result.result))) as T;
}

export function shipData(account: string, ship: Ship) {
  return { [account]: { nearverse: { ship: { name: ship.name, biography: ship.biography, art: ship.art } } } };
}

/** Deposit needed so the account's SocialDB storage covers the ship. Unused deposit stays withdrawable. */
export function shipDeposit(account: string, ship: Ship, storage: { available_bytes: number } | null): bigint {
  const bytes = BigInt(new TextEncoder().encode(JSON.stringify(shipData(account, ship))).length + OVERHEAD_BYTES);
  if (!storage) return SOCIAL_MIN_DEPOSIT + bytes * YOCTO_PER_BYTE;
  const missing = bytes - BigInt(storage.available_bytes);
  return missing > 0n ? missing * YOCTO_PER_BYTE : 0n;
}

export async function readSocialStorage(account: string, fetcher?: typeof fetch) {
  return view<{ used_bytes: number; available_bytes: number } | null>('get_account_storage', { account_id: account }, fetcher);
}

export async function readOnChainShip(account: string, fetcher?: typeof fetch): Promise<Ship | null> {
  const result = await view<Record<string, { nearverse?: { ship?: Record<string, unknown> } }>>('get', { keys: [`${account}/nearverse/ship/**`] }, fetcher);
  const raw = result?.[account]?.nearverse?.ship;
  if (!raw || typeof raw.name !== 'string' || typeof raw.biography !== 'string' || !['courier', 'surveyor', 'sail'].includes(String(raw.art))) return null;
  // Public data written by anyone's wallet: bound sizes, rendered as plain text only.
  return { name: raw.name.slice(0, 60), biography: raw.biography.slice(0, 2000), art: raw.art as Ship['art'] };
}

export function shipTransaction(account: string, ship: Ship, deposit: bigint) {
  return { transactions: [{ signerId: account, receiverId: SOCIAL_CONTRACT, actions: [{ type: 'FunctionCall' as const, params: { methodName: 'set', args: { data: shipData(account, ship) }, gas: SHIP_GAS, deposit: deposit.toString() } }] }] };
}
