import { createHash, randomBytes } from 'node:crypto';
import { PublicKey } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { serialize } from 'borsh';

export interface Challenge { id: string; accountId: string; message: string; nonce: string; recipient: string; expiresAt: number; purpose?: 'agent' }
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function nep413Hash(challenge: Challenge): Uint8Array {
  const bytes = serialize({ struct: { tag: 'u32', message: 'string', nonce: { array: { type: 'u8', len: 32 } }, recipient: 'string', callbackUrl: { option: 'string' } } }, {
    tag: 2147484061, message: challenge.message, nonce: [...Buffer.from(challenge.nonce, 'base64')], recipient: challenge.recipient, callbackUrl: null,
  });
  return createHash('sha256').update(bytes).digest();
}
export function verifySignature(challenge: Challenge, publicKey: string, signature: string): boolean {
  try {
    if (!publicKey.startsWith('ed25519:') || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    return PublicKey.fromString(publicKey).verify(nep413Hash(challenge), Buffer.from(signature, 'base64'));
  } catch { return false; }
}
export async function bounded<T>(work: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('upstream_timeout')), ms); })]); }
  finally { clearTimeout(timer!); }
}
export function ownershipVerifier(rpcUrl = 'https://rpc.mainnet.near.org') {
  const rpc = new JsonRpcProvider({ url: rpcUrl }, { retries: 1 });
  return async (accountId: string, publicKey: string): Promise<boolean> => {
    const key = await bounded(rpc.viewAccessKey(accountId, PublicKey.fromString(publicKey), { finality: 'final' }));
    // Restricted contract keys must not grant access to a whole account's journal.
    return key.permission === 'FullAccess';
  };
}
