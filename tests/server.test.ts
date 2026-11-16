// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KeyPair } from '@near-js/crypto';
import { createApp, type AppOptions } from '../server/app';
import { nep413Hash, type Challenge, bounded, verifySignature, ownershipVerifier } from '../server/auth';
import { openStore, backupStore, restoreStore } from '../server/store';
import { verifyArrival, type ArrivalProof } from '../server/upstream';

const origin = 'http://localhost:5173';
const proof: ArrivalProof = { depositAddress: 'deposit-123', originAsset: 'nep141:wrap.near', destinationAsset: 'nep141:nbtc.bridge.near', amountIn: '100', amountOut: '200', minAmountOut: '190' };
let server: Server; let base: string; let time: number; let db: ReturnType<typeof openStore>;
let owns: ReturnType<typeof vi.fn<NonNullable<AppOptions['verifyOwnership']>>>; let arrives: ReturnType<typeof vi.fn<NonNullable<AppOptions['verifyArrival']>>>;
async function request(path: string, method = 'GET', body?: unknown, cookie?: string, requestOrigin: string | null = origin) {
  const headers: Record<string,string> = { 'Content-Type': 'application/json' };
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  if (cookie) headers.Cookie = cookie;
  return fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function login(accountId = 'alice.near') {
  const challenge = await (await request('/api/auth/challenge','POST',{ accountId })).json() as Challenge;
  const key = KeyPair.fromRandom('ed25519'); // Disposable OFFLINE fixture; no wallet/RPC/sign-in interaction.
  const signed = key.sign(nep413Hash(challenge));
  const body = { challengeId: challenge.id, accountId, publicKey: key.getPublicKey().toString(), signature: Buffer.from(signed.signature).toString('base64') };
  const response = await request('/api/auth/verify','POST',body);
  expect(response.status).toBe(200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], body, challenge, response };
}
async function start(overrides: Partial<AppOptions> = {}) {
  time = 1800000000000; db = openStore(); owns = vi.fn(async () => true); arrives = vi.fn(async () => true);
  server = createApp({ origin, db, now: () => time, verifyOwnership: owns, verifyArrival: arrives, homeSystemId: 'near-lada', ...overrides }).listen(0,'127.0.0.1');
  await once(server,'listening'); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
beforeEach(async () => { await start(); });
afterEach(async () => { vi.unstubAllGlobals(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); });
const event = (eventId: string, type: string, storyId = 'lada-1', systemId = 'near-lada') => ({ eventId, type, systemId, storyId });
describe('history HTTP security and ordering', () => {
  it('health/session unauthenticated behavior, strict origin and no-store', async () => {
    const health = await request('/api/health'); expect(await health.json()).toEqual({ ok: true }); expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await (await request('/api/auth/session')).json()).toEqual({ accountId: null });
    expect((await request('/api/events')).status).toBe(401);
    expect((await request('/api/auth/challenge','POST',{accountId:'alice.near'},undefined,null)).status).toBe(403);
    expect((await request('/api/auth/challenge','POST',{accountId:'alice.near'},undefined,'https://evil.test')).status).toBe(403);
    expect((await request('/api/events','GET',undefined,undefined,'https://evil.test')).status).toBe(403);
  });
  it('has no free home system by default: every chapter needs a verified arrival', async () => {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close();
    await start({ homeSystemId: undefined });
    const { cookie } = await login();
    const r = await request('/api/events','POST',event('e1','expedition.started'),cookie);
    expect(r.status).toBe(409);
  });
  it('real NEP-413 signatures, nonce/domain binding, one-use and cookie revocation', async () => {
    const { cookie, body, challenge, response } = await login();
    expect(response.headers.get('set-cookie')).toContain('HttpOnly'); expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect(verifySignature({...challenge,recipient:'evil.test'},body.publicKey,body.signature)).toBe(false);
    expect(verifySignature({...challenge,nonce:Buffer.alloc(32).toString('base64')},body.publicKey,body.signature)).toBe(false);
    expect((await request('/api/auth/verify','POST',body)).status).toBe(401);
    expect((await (await request('/api/auth/session','GET',undefined,cookie)).json()).accountId).toBe('alice.near');
    expect((await request('/api/auth/logout','POST',{},cookie)).status).toBe(200);
    expect((await request('/api/events','GET',undefined,cookie)).status).toBe(401);
  });
  it('rejects tampering, malformed account, expired challenge, failed ownership and RPC errors', async () => {
    expect((await request('/api/auth/challenge','POST',{ accountId:'bad..near' })).status).toBe(400);
    const challenge = await (await request('/api/auth/challenge','POST',{accountId:'alice.near'})).json();
    const key = KeyPair.fromRandom('ed25519');
    const body = { challengeId: challenge.id, accountId:'alice.near', publicKey:key.getPublicKey().toString(),signature:Buffer.from(key.sign(nep413Hash(challenge)).signature).toString('base64') };
    time += 300001;
    expect((await request('/api/auth/verify','POST',body)).status).toBe(401);
    owns.mockResolvedValueOnce(false);
    const next = await (await request('/api/auth/challenge','POST',{accountId:'alice.near'})).json();
    expect((await request('/api/auth/verify','POST',{...body,challengeId:next.id,signature:Buffer.from(key.sign(nep413Hash(next)).signature).toString('base64')})).status).toBe(401);
    owns.mockRejectedValueOnce(new Error('rpc unavailable'));
    const third = await (await request('/api/auth/challenge','POST',{accountId:'alice.near'})).json();
    expect((await request('/api/auth/verify','POST',{...body,challengeId:third.id,signature:Buffer.from(key.sign(nep413Hash(third)).signature).toString('base64')})).status).toBe(503);
    expect((db.prepare('SELECT count(*) AS n FROM sessions').get() as {n:number}).n).toBe(0);
  });
  it('server timers, sequential unlock, exact retries, owner isolation, export and delete', async () => {
    const alice = await login(); const bob = await login('bob.near');
    expect((await request('/api/events','POST',event('outoforder','expedition.started','lada-2'),alice.cookie)).status).toBe(409);
    expect((await request('/api/events','POST',event('foreign','expedition.started','basalt-1','btc-basalt'),alice.cookie)).status).toBe(409);
    const started = await request('/api/events','POST',event('start','expedition.started'),alice.cookie);
    expect(started.status).toBe(201); const record = (await started.json()).event; expect(record.readyAt).toBe(time+15000);
    expect((await request('/api/events','POST',event('start','expedition.started'),alice.cookie)).status).toBe(200);
    expect((await request('/api/events','POST',event('start','story.read'),alice.cookie)).status).toBe(409);
    expect((await request('/api/events','POST',event('early','expedition.completed'),alice.cookie)).status).toBe(409);
    expect((await request('/api/events','POST',event('readEarly','story.read'),alice.cookie)).status).toBe(409);
    time += 15000;
    expect((await request('/api/events','POST',event('complete','expedition.completed'),alice.cookie)).status).toBe(201);
    expect((await request('/api/events','POST',event('read','story.read'),alice.cookie)).status).toBe(201);
    expect((await request('/api/events','POST',event('second','expedition.started','lada-2'),alice.cookie)).status).toBe(201);
    expect((await (await request('/api/events','GET',undefined,bob.cookie)).json()).events).toHaveLength(0);
    const exported = await (await request('/api/journal','GET',undefined,alice.cookie)).json(); expect(exported.events).toHaveLength(4); expect(exported.accountId).toBe('alice.near');
    expect((await request('/api/journal','DELETE',{},bob.cookie)).status).toBe(200);
    expect((await (await request('/api/events','GET',undefined,alice.cookie)).json()).events).toHaveLength(4);
    expect((await request('/api/journal','DELETE',{},alice.cookie)).status).toBe(200);
    expect((await (await request('/api/events','GET',undefined,alice.cookie)).json()).events).toHaveLength(0);
  });
  it('binds expected account headers and permits exploration throughout an unlocked asset region', async () => {
    const {cookie} = await login();
    const rejected = await fetch(base+'/api/events',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-Nearverse-Account':'bob.near'},body:JSON.stringify(event('cross-tab','expedition.started'))});
    expect(rejected.status).toBe(409);
    expect((db.prepare('SELECT count(*) AS n FROM events').get() as {n:number}).n).toBe(0);
    expect((await request('/api/events','POST',event('near-free','expedition.started','echo-1','near-echo'),cookie)).status).toBe(201);
  });
  it('cannot accept SUCCESS claims; verifies arrivals and avoids replay or financial storage', async () => {
    const {cookie} = await login();
    expect((await request('/api/events','POST',{eventId:'bad',type:'arrival',systemId:'btc-basalt',status:'SUCCESS'},cookie)).status).toBe(400);
    arrives.mockResolvedValueOnce(false);
    const arrival = {eventId:'arrival1',type:'arrival',systemId:'btc-basalt',proof};
    expect((await request('/api/events','POST',arrival,cookie)).status).toBe(409);
    expect((await (await request('/api/events','GET',undefined,cookie)).json()).events).toHaveLength(0);
    expect((await request('/api/events','POST',arrival,cookie)).status).toBe(201);
    expect(arrives).toHaveBeenCalledWith('alice.near',{systemId:'btc-basalt',assetId:'nep141:nbtc.bridge.near'},proof);
    expect((await request('/api/events','POST',{...arrival,eventId:'replay'},cookie)).status).toBe(409);
    const stored = JSON.stringify(db.prepare('SELECT * FROM events').all());
    expect(stored).not.toContain('deposit-123'); expect(stored).not.toContain('amountIn');
    expect((await request('/api/events','POST',event('explore','expedition.started','basalt-1','btc-basalt'),cookie)).status).toBe(201);
  });
  it('consumes challenges atomically under concurrent verification and rejects a wrong account', async () => {
    const challenge = await (await request('/api/auth/challenge','POST',{accountId:'alice.near'})).json();
    const key = KeyPair.fromRandom('ed25519');
    const body = { challengeId:challenge.id, accountId:'alice.near', publicKey:key.getPublicKey().toString(), signature:Buffer.from(key.sign(nep413Hash(challenge)).signature).toString('base64') };
    const responses = await Promise.all([request('/api/auth/verify','POST',body),request('/api/auth/verify','POST',body)]);
    expect(responses.map(r => r.status).sort()).toEqual([200,401]);
    expect(owns).toHaveBeenCalledTimes(1);
    const second = await (await request('/api/auth/challenge','POST',{accountId:'alice.near'})).json();
    const wrong = {...body, challengeId:second.id, accountId:'bob.near', signature:Buffer.from(key.sign(nep413Hash(second)).signature).toString('base64')};
    expect((await request('/api/auth/verify','POST',wrong)).status).toBe(401);
  });
  it('logout while an arrival is checking prevents a late write', async () => {
    const {cookie} = await login();
    let release!: (value: boolean) => void;
    let entered!: () => void; const checking = new Promise<void>(r => { entered = r; });
    arrives.mockImplementationOnce(() => { entered(); return new Promise<boolean>(r => { release = r; }); });
    const inflight = request('/api/events','POST',{eventId:'late',type:'arrival',systemId:'btc-basalt',proof},cookie);
    await checking;
    expect((await request('/api/auth/logout','POST',{},cookie)).status).toBe(200);
    release(true); expect((await inflight).status).toBe(401);
    expect((db.prepare('SELECT count(*) AS n FROM events').get() as {n:number}).n).toBe(0);
  });
  it('deletion fences an already-running upstream arrival and never resurrects the journal', async()=>{
    const {cookie}=await login();let release!:(value:boolean)=>void;let entered!:()=>void;
    const checking=new Promise<void>(r=>{entered=r;});arrives.mockImplementationOnce(()=>{entered();return new Promise<boolean>(r=>{release=r;});});
    const inflight=request('/api/events','POST',{eventId:'deleted-arrival',type:'arrival',systemId:'btc-basalt',proof},cookie);await checking;
    expect((await request('/api/journal','DELETE',{},cookie)).status).toBe(200);release(true);
    const rejected=await inflight;expect(rejected.status).toBe(409);expect((await rejected.json()).error).toBe('journal_deleted');
    expect((await (await request('/api/events','GET',undefined,cookie)).json()).events).toEqual([]);
  });
  it('caps body and requests, rejects client time/owner and expires sessions', async () => {
    const {cookie} = await login();
    expect((await request('/api/events','POST',{...event('owner','expedition.started'),owner:'bob.near'},cookie)).status).toBe(400);
    expect((await request('/api/events','POST',{...event('time','expedition.started'),createdAt:0},cookie)).status).toBe(400);
    expect((await request('/api/events','POST',{data:'x'.repeat(9000)},cookie)).status).toBe(413);
    time += 86400001;
    expect((await request('/api/events','GET',undefined,cookie)).status).toBe(401);
    let last = 0; for (let i=0;i<121;i++) last = (await request('/api/health')).status;
    expect(last).toBe(429);
  });
});
describe('upstream verification and backup', () => {
  function result() { return { status:'SUCCESS',swapDetails:{amountIn:proof.amountIn,amountOut:proof.amountOut},quoteResponse:{quoteRequest:{depositType:'INTENTS',refundType:'INTENTS',recipientType:'INTENTS',recipient:'alice.near',refundTo:'alice.near',originAsset:proof.originAsset,destinationAsset:proof.destinationAsset},quote:{depositAddress:proof.depositAddress,amountIn:proof.amountIn,amountOut:proof.amountOut,minAmountOut:proof.minAmountOut}} }; }
  it('production status verifier binds account, assets, amounts, finality and memo', async () => {
    const call = vi.fn(); vi.stubGlobal('fetch',call);
    const check = async (value: unknown) => { call.mockResolvedValueOnce(new Response(JSON.stringify(value))); return verifyArrival('alice.near',{systemId:'btc-basalt',assetId:proof.destinationAsset},proof); };
    expect(await check(result())).toBe(true);
    for (const status of ['PENDING_DEPOSIT','PROCESSING','REFUNDED','FAILED','INCOMPLETE_DEPOSIT']) expect(await check({...result(),status})).toBe(false);
    const wrongOwner = result(); wrongOwner.quoteResponse.quoteRequest.refundTo='bob.near'; expect(await check(wrongOwner)).toBe(false);
    const wrongAsset = result(); wrongAsset.quoteResponse.quoteRequest.destinationAsset='other'; expect(await check(wrongAsset)).toBe(false);
    const missingDetails = {...result(),swapDetails:undefined}; expect(await check(missingDetails)).toBe(false);
    const lowOutput = result(); lowOutput.swapDetails.amountOut='1'; expect(await check(lowOutput)).toBe(false);
    const wrongAmount = result(); wrongAmount.quoteResponse.quote.amountIn='999'; expect(await check(wrongAmount)).toBe(false);
    expect(call.mock.calls[0][0].toString()).toBe('https://1click.chaindefuser.com/v0/status?depositAddress=deposit-123');
  });
  it('official NEAR provider uses final access-key lookup and rejects restricted keys', async () => {
    const call = vi.fn(); vi.stubGlobal('fetch', call);
    const key = KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const check = ownershipVerifier();
    call.mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{nonce:1,permission:'FullAccess'}})));
    expect(await check('alice.near',key)).toBe(true);
    const rpcBody = JSON.parse(call.mock.calls[0][1].body);
    expect(rpcBody.method).toBe('query'); expect(rpcBody.params).toMatchObject({request_type:'view_access_key',finality:'final',account_id:'alice.near',public_key:key});
    call.mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:'2.0',id:2,result:{nonce:1,permission:{FunctionCall:{receiver_id:'untrusted.near',method_names:[]}}}})));
    expect(await check('alice.near',key)).toBe(false);
  });
  it('bounds stalled verification', async () => { await expect(bounded(new Promise(()=>{}),10)).rejects.toThrow('upstream_timeout'); });
  it('backup/restore preserves journal and revokes sessions without overwriting', async () => {
    const {cookie} = await login(); await request('/api/events','POST',event('backup','expedition.started'),cookie);
    const dir = mkdtempSync(join(tmpdir(),'nearverse-backup-'));
    const backup = join(dir,'backup.sqlite'); const restored = join(dir,'restored.sqlite');
    try {
      await backupStore(db,backup); expect(statSync(backup).mode & 0o777).toBe(0o600);
      await restoreStore(backup,restored);
      const read = openStore(restored);
      try { expect((read.prepare('SELECT count(*) AS n FROM events').get() as {n:number}).n).toBe(1); expect((read.prepare('SELECT count(*) AS n FROM sessions').get() as {n:number}).n).toBe(0); } finally {read.close();}
      await expect(restoreStore(backup,restored)).rejects.toThrow('restore_target_exists');
      await expect(backupStore(db,backup)).rejects.toThrow('backup_target_exists');
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
