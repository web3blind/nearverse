// @vitest-environment node
import React from 'react';
import {afterAll,afterEach, expect, it, vi} from 'vitest';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {KeyPair} from '@near-js/crypto';
import type {WidgetConfig} from '@aurora-is-near/intents-swap-widget/types';
import {createApp} from '../server/app';
import {openStore} from '../server/store';
import {nep413Hash} from '../server/auth';
// Run the HTTP/official-crypto half in Node's byte-array realm. Only DOM globals
// come from jsdom; never replace native Uint8Array or crypto in the server.
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1:5173',pretendToBeVisual:true});
for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','MutationObserver','localStorage','getComputedStyle','requestAnimationFrame'])vi.stubGlobal(name,dom.window[name]);
Object.defineProperty(window,'matchMedia',{writable:true,value:vi.fn(()=>({matches:false,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}))});
const {cleanup,fireEvent,render,screen,waitFor}=await import('@testing-library/react');
const {WidgetConfigProvider}=await import('@aurora-is-near/intents-swap-widget/config');
const {HeadlessConverter}=await import('../src/sdk/HeadlessConverter');
let server:Server|undefined;let db:ReturnType<typeof openStore>|undefined;
afterEach(async()=>{cleanup();if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}db?.close();db=undefined;});
afterAll(()=>{dom.window.close();vi.unstubAllGlobals();});
it('actual UI challenge → controlled offline signer → actual HTTP verifier/cookie → session/logout; never requests a transaction',async()=>{
 db=openStore();const appOrigin='http://127.0.0.1:5173';
 const key=KeyPair.fromRandom('ed25519');
 server=createApp({origin:appOrigin,db,verifyOwnership:async(account,pub)=>account==='fixture.near'&&pub===key.getPublicKey().toString()}).listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const networkFetch=globalThis.fetch;let cookie='';const requests:string[]=[];
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input);if(!path.startsWith('/api/'))throw new Error('Unexpected network: '+path);
  requests.push(path);const headers=new Headers(init?.headers);headers.set('Origin',appOrigin);if(cookie)headers.set('Cookie',cookie);
  const response=await networkFetch(base+path,{...init,headers});const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];return response;
 });
 const transfer=vi.fn(()=>{throw new Error('NO TRANSACTIONS IN FIXTURE TEST');});
 const signMessage=vi.fn(async(params:{message:string;recipient:string;nonce:Uint8Array})=>({accountId:'fixture.near',publicKey:key.getPublicKey().toString(),signature:Buffer.from(key.sign(nep413Hash({id:'unused',accountId:'fixture.near',expiresAt:0,...params,nonce:Buffer.from(params.nonce).toString('base64')})).signature).toString('base64')}));
 const wallet={signMessage,signAndSendTransaction:transfer,signAndSendTransactions:transfer};
 const config:Partial<WidgetConfig>={connectedWallets:{default:'fixture.near'},intentsAccountType:'near',providers:{near:()=>wallet as ReturnType<NonNullable<NonNullable<WidgetConfig['providers']>['near']>>},onWalletSignout:vi.fn()};
 const signedIn=vi.fn();render(<WidgetConfigProvider config={config}><HeadlessConverter preview={false} systemId="near-lada" targetAsset="NEAR" onHistorySession={signedIn}/></WidgetConfigProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Sign in to journal: sign a message, no funds transferred'}));
 await waitFor(()=>expect(screen.getByText(/History: signed in/)).toBeTruthy(),{timeout:10000});
 expect(signMessage).toHaveBeenCalledTimes(1);expect(signedIn).toHaveBeenCalledWith(true);expect(requests).toContain('/api/auth/verify');
 fireEvent.click(screen.getByRole('button',{name:'Sign out'}));
 await waitFor(()=>expect(screen.getByText(/History: not signed in/)).toBeTruthy());
 const session=await (await globalThis.fetch('/api/auth/session')).json();expect(session.accountId).toBeNull();expect(transfer).not.toHaveBeenCalled();
},20000);
