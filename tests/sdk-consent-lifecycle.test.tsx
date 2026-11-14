// @vitest-environment jsdom
// Component regressions with a controlled SDK hook/provider boundary. The actual
// converter, preflight RPC parsing, signing guards and durable ledger execute.
// This deliberately does not claim composition of the memory-blocked real SDK.
import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {Token,NearSignAndSendTransactionsParams} from '@aurora-is-near/intents-swap-widget/types';
import {HeadlessConverter} from '../src/sdk/HeadlessConverter';
const h=vi.hoisted(()=>({config:{} as Record<string,unknown>,ctx:{} as Record<string,unknown>,status:{} as Record<string,unknown>,tokens:[] as Token[],make:vi.fn(),send:vi.fn(),sign:vi.fn()}));
vi.mock('@aurora-is-near/intents-swap-widget/config',()=>({useConfig:()=>h.config}));
vi.mock('@aurora-is-near/intents-swap-widget/machine',()=>({useStoreSideEffects:()=>{},useUnsafeSnapshot:()=>({ctx:h.ctx}),fireEvent:()=>{},machine:{getStore:()=>({context:h.ctx})}}));
vi.mock('@aurora-is-near/intents-swap-widget/hooks',()=>({
 useAllTokens:()=>({tokens:h.tokens}),useWalletConnection:()=>({}),useWalletBalance:()=>({walletBalance:{}}),useIntentsBalance:()=>({intentBalances:{}}),useIntentsAccountType:()=>({intentsAccountType:'near'}),useOneClickExecutionStatus:()=>({data:h.status,isError:false}),
 useMakeTransfer:({providers}:{providers:{near:()=>{signAndSendTransactions:(params:NearSignAndSendTransactionsParams)=>Promise<unknown>}}})=>({make:async()=>{h.make();await providers.near().signAndSendTransactions({transactions:[{signerId:'alice.near',receiverId:'deposit.near',actions:[{type:'Transfer',params:{deposit:'100000000000000000000000'}}]}]});}}),
}));
const owner='alice.near';
const pendingKey=`nearverse:pending:${owner}`;
const budgetKey=`nearverse:qa-budget:${owner}`;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
let lockCallback:(()=>Promise<unknown>)|undefined;
let deferLock=false;
const oldLocks=Object.getOwnPropertyDescriptor(navigator,'locks');
beforeEach(()=>{
 localStorage.clear();vi.clearAllMocks();deferLock=false;lockCallback=undefined;
 const source:Token={assetId:'native-near',isIntent:false,decimals:24,blockchain:'near',symbol:'NEAR',price:3,icon:'',name:'NEAR',chainName:'NEAR'};
 const target:Token={...source,assetId:'nep141:nbtc.bridge.near',isIntent:true,decimals:8,symbol:'BTC'};
 const quote={type:'QUOTE_REAL_WITH_AMOUNT',dry:false,depositAddress:'deposit.near',amountIn:'100000000000000000000000',amountInUsd:'0.3',amountOut:'200',deadline:'2099-01-01T00:00:00Z'};
 h.tokens=[source,target];h.ctx={sourceToken:source,targetToken:target,quote,state:'idle'};
 h.config={connectedWallets:{near:owner},providers:{near:()=>({signMessage:h.sign,signAndSendTransactions:h.send})},slippageTolerance:100,appFees:[]};
 h.status={status:'PENDING_DEPOSIT',quoteResponse:{quote:{...quote,minAmountOut:'190'},quoteRequest:{dry:false,slippageTolerance:100,appFees:[],deadline:'2099-01-01T01:00:00Z',amount:quote.amountIn,swapType:'EXACT_INPUT',depositType:'ORIGIN_CHAIN',refundType:'ORIGIN_CHAIN',recipientType:'INTENTS',recipient:owner,refundTo:owner,originAsset:'nep141:wrap.near',destinationAsset:target.assetId}}};
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,_options:unknown,callback:(lock:unknown)=>Promise<unknown>)=>{if(deferLock){const gate=deferred();lockCallback=async()=>{try{return await callback({name:'fixture'});}finally{gate.resolve();}};return gate.promise;}return callback({name:'fixture'});}}});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();if(oldLocks)Object.defineProperty(navigator,'locks',oldLocks);else Reflect.deleteProperty(navigator,'locks');localStorage.clear();});
function reserveGate(phase:number){
 const started=deferred(),released=deferred();let queries=0;
 vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
  if(path==='/api/auth/session')return Response.json({accountId:owner});
  if(path!=='https://free.rpc.fastnear.com')throw Error('Unexpected fixture network');
  const body=JSON.parse(String(init?.body));
  if(body.method==='query'){queries++;if(queries===phase){started.resolve();await released.promise;}return Response.json({result:{amount:'1000000000000000000000000',locked:'0',storage_usage:2000}});}
  if(body.method==='gas_price')return Response.json({result:{gas_price:'100000000'}});
  if(body.method==='EXPERIMENTAL_protocol_config')return Response.json({result:{runtime_config:{storage_amount_per_byte:'10000000000000000000'}}});
  throw Error('Unexpected fixture RPC');
 }));
 return {started:started.promise,release:async()=>{await act(async()=>{released.resolve();});}};
}
const element=(preview=false)=><HeadlessConverter preview={preview} apiKey="offline-fixture" systemId="btc-basalt" targetAsset="BTC"/>;
async function begin(){await screen.findByText(/History: signed in/);fireEvent.click(screen.getByRole('checkbox'));const button=screen.getByRole('button',{name:'Approve terms and request swap signature'});expect((button as HTMLButtonElement).disabled).toBe(false);fireEvent.click(button);}
function noNewOperation(){expect(h.make).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();expect(h.sign).not.toHaveBeenCalled();expect(localStorage.getItem(pendingKey)).toBeNull();expect(localStorage.getItem(budgetKey)).toBeNull();}
it('revocation during preflight creates no budget/pending and invokes no provider',async()=>{const gate=reserveGate(1);render(element());await begin();await gate.started;fireEvent.click(screen.getByRole('checkbox'));await gate.release();noNewOperation();});
it('revocation then reacceptance cannot revive the earlier preflight',async()=>{const gate=reserveGate(1);render(element());await begin();await gate.started;fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('checkbox'));await gate.release();noNewOperation();});
it('unmount during preflight prevents any new operation',async()=>{const gate=reserveGate(1);const view=render(element());await begin();await gate.started;view.unmount();await gate.release();noNewOperation();});
it('switching to preview during preflight prevents any new operation',async()=>{const gate=reserveGate(1);const view=render(element());await begin();await gate.started;view.rerender(element(true));await gate.release();noNewOperation();});
it.each(['unmount','preview'])('%s while the signing-boundary RPC waits blocks wallet but retains unknown pending',async change=>{const gate=reserveGate(2);const view=render(element());await begin();await gate.started;expect(h.make).toHaveBeenCalledTimes(1);const saved=localStorage.getItem(pendingKey);expect(saved).not.toBeNull();if(change==='unmount')view.unmount();else view.rerender(element(true));await gate.release();expect(h.send).not.toHaveBeenCalled();expect(h.sign).not.toHaveBeenCalled();expect(localStorage.getItem(pendingKey)).toBe(saved);expect(JSON.parse(localStorage.getItem(budgetKey)!).operations).toHaveProperty(`${JSON.parse(saved!).eventId}:route-fees`);});
it('revocation before the Web Lock callback prevents stale accepted closure execution',async()=>{reserveGate(0);deferLock=true;render(element());await begin();expect(lockCallback).toBeTypeOf('function');fireEvent.click(screen.getByRole('checkbox'));await act(async()=>{await lockCallback!();});noNewOperation();});
it('quote replacement during signing-boundary preflight blocks wallet and preserves pending',async()=>{const gate=reserveGate(2);const view=render(element());await begin();await gate.started;const saved=localStorage.getItem(pendingKey);h.ctx={...h.ctx,quote:{...(h.ctx.quote as object)}};view.rerender(element());await gate.release();expect(h.send).not.toHaveBeenCalled();expect(localStorage.getItem(pendingKey)).toBe(saved);});
it('internal checkbox reset does not revoke the already-confirmed operation under StrictMode',async()=>{const gate=reserveGate(1);render(<React.StrictMode>{element()}</React.StrictMode>);await begin();await gate.started;await gate.release();await waitFor(()=>expect(h.send).toHaveBeenCalledTimes(1));expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);expect(localStorage.getItem(pendingKey)).not.toBeNull();expect(Object.keys(JSON.parse(localStorage.getItem(budgetKey)!).operations)).toHaveLength(2);});
