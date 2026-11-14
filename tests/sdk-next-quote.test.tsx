// @vitest-environment jsdom
// Actual SDK provider, event subscriptions, input guards and quote effect.
// Only external responses and the browser Web Lock are controlled; no money moves.
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {useQueryClient} from '@tanstack/react-query';
import {WidgetConfigProvider} from '@aurora-is-near/intents-swap-widget/config';
import {fireEvent as sdkEvent,machine} from '@aurora-is-near/intents-swap-widget/machine';
import {HeadlessConverter} from '../src/sdk/HeadlessConverter';
import {useFinancialActivation} from '../src/sdk/financialActivation';
import type {PendingJourney} from '../src/sdk/safety';
const owner='alice.near',pendingKey=`nearverse:pending:${owner}`,budgetKey=`nearverse:qa-budget:${owner}`;
const j:PendingJourney={eventId:'confirmed-first',systemId:'btc-basalt',accountId:owner,depositAddress:'offline-first',originAsset:'nep141:usdt.tether-token.near',destinationAsset:'nep141:nbtc.bridge.near',amountIn:'180000',amountOut:'200',minAmountOut:'190'};
const base={blockchain:'near' as const,price:1,icon:'',name:'fixture',chainName:'NEAR',isIntent:true};
const source={...base,assetId:j.originAsset,symbol:'USDT',decimals:6};
const target={...base,assetId:j.destinationAsset,symbol:'BTC',decimals:8};
const simpleTokens=[source,target].map(({isIntent:_intent,chainName:_chain,name:_name,...token})=>token);
const oldLocks=Object.getOwnPropertyDescriptor(navigator,'locks');
Object.defineProperty(window,'matchMedia',{writable:true,value:()=>({matches:false,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()})});
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();if(oldLocks)Object.defineProperty(navigator,'locks',oldLocks);else Reflect.deleteProperty(navigator,'locks');});
let activeCache:ReturnType<typeof useQueryClient>;
function Seed(){const cache=useQueryClient();activeCache=cache;cache.setQueryData(['fee-service-tokens',undefined],{tokens:simpleTokens,assetStats:[]});cache.setQueryData(['oneClickExecutionStatus','offline-next'],{status:'FAILED'});cache.setQueryData(['walletBalances',{near:owner}],{});cache.setQueryData(['oneClickExecutionStatus',j.depositAddress],{status:'SUCCESS',quoteResponse:{quoteRequest:{originAsset:j.originAsset,destinationAsset:j.destinationAsset,recipient:owner,refundTo:owner,recipientType:'INTENTS'},quote:{depositAddress:j.depositAddress,amountIn:j.amountIn,amountOut:j.amountOut,minAmountOut:j.minAmountOut}},swapDetails:{amountIn:j.amountIn,amountOut:j.amountOut}});cache.setQueryData(['intentsBalances',owner,[source.assetId,target.assetId].sort()],{[source.assetId]:'900000',[target.assetId]:'200'});return null;}
function ObservedConverter(props:React.ComponentProps<typeof HeadlessConverter>){
 const activation=useFinancialActivation();return <HeadlessConverter {...props} {...activation}/>;
}
async function prepare(outcome:'ok'|'409'|'changed'|'busy'|'missing'='ok',activationRecoveryBlocked=false,activationRecoveryEntries?:Record<string,string>,observeStartup=false){
 const Converter=observeStartup?ObservedConverter:HeadlessConverter;
 const budget=JSON.stringify({version:1,account:owner,spent:'123456',operations:{'previous-fee':'123456'}});localStorage.setItem(pendingKey,JSON.stringify(j));localStorage.setItem(budgetKey,budget);
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,_options:unknown,callback:(lock:unknown)=>unknown)=>callback(outcome==='busy'?null:{name:'fixture'})}});
 const network=vi.fn(async(path:RequestInfo|URL)=>{if(path==='/api/auth/session')return Response.json({accountId:owner});if(path==='/api/events'){if(outcome==='changed')localStorage.setItem(pendingKey,JSON.stringify({...j,eventId:'other-operation'}));if(outcome==='missing')localStorage.removeItem(pendingKey);return Response.json({event:{eventId:j.eventId}},{status:outcome==='409'?409:200});}throw new Error('Unexpected offline network request');});vi.stubGlobal('fetch',network);
 const fetchQuote=vi.fn(async(input:{amount:string})=>({depositAddress:'offline-next',amountIn:input.amount,amountOut:'300',minAmountIn:'1',minAmountOut:'290',amountInFormatted:'0.2',amountOutFormatted:'0.000003',amountInUsd:'0.2',amountOutUsd:'0.2',timeEstimate:5,deadline:'2099-01-01T00:00:00Z'}));
 const sign=vi.fn(async()=>{throw new Error('Signing is forbidden in this offline quote regression');});const send=vi.fn(async()=>{throw new Error('Sending is forbidden in this offline quote regression');});
 const arrival=vi.fn();render(<WidgetConfigProvider balanceViaRpc={false} config={{connectedWallets:{near:owner},providers:{near:()=>({signMessage:sign,signAndSendTransactions:send})},enableAccountAbstraction:true,fetchSourceTokens:async()=>simpleTokens,fetchTargetTokens:async()=>simpleTokens,fetchQuote,slippageTolerance:100,appFees:[]}}><Seed/><Converter activationRecoveryEntries={activationRecoveryEntries} activationRecoveryBlocked={activationRecoveryBlocked} preview={false} apiKey="offline-quote-effect" targetAsset="BTC" systemId="btc-basalt" onArrival={arrival}/></WidgetConfigProvider>);
 await screen.findByText(/History: signed in/);await screen.findByRole('option',{name:/USDT · Intents/});
 if(activationRecoveryEntries)await screen.findByText(/A saved recovery record disappeared or changed before the wallet module loaded/);
 // Reconstruct the observed completed-transfer lifecycle through supported SDK
 // events, not a forced state/context assignment or an SDK-module mock.
 act(()=>{sdkEvent('reset',{clearWalletAddress:false});sdkEvent('tokenSelect',{variant:'source',token:source});sdkEvent('tokenSelect',{variant:'target',token:target});});
 await waitFor(()=>expect(machine.getStore().context).toMatchObject({walletAddress:owner,sourceTokenBalance:'900000'}));
 act(()=>sdkEvent('tokenSetAmount',{variant:'source',amount:j.amountIn}));
 await waitFor(()=>expect(machine.getStore().context.quote?.depositAddress).toBe('offline-next'),{timeout:5000});
 // Let the SDK's mount-time slippage debounce settle before reproducing the
 // completed transfer, as it already has on an actual long-running swap page.
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1200));});
 await waitFor(()=>expect(machine.getStore().context).toMatchObject({state:'quote_success_internal',quoteStatus:'success',walletAddress:owner}));
 act(()=>sdkEvent('transferSetStatus',{status:'error'}));
 expect(machine.getStore().context.transferStatus.status).toBe('error');
 const verify=screen.getByRole('button',{name:'Verify arrival with the server'});await waitFor(()=>expect((verify as HTMLButtonElement).disabled).toBe(false));fireEvent.click(verify);
 return {budget,network,fetchQuote,arrival,sign,send};
}
it('server-confirmed success makes the next real SDK quote usable without reload or inherited consent',async()=>{
 const {budget,fetchQuote,arrival,sign,send}=await prepare();await screen.findByText('The server has confirmed arrival.');
 expect(localStorage.getItem(pendingKey)).toBeNull();expect(arrival).toHaveBeenCalledTimes(1);
 // Same user-facing selection sequence which previously left transferStatus:error.
 fireEvent.change(screen.getByRole('combobox',{name:'Source asset'}),{target:{value:`${source.assetId}|intents`}});
 fireEvent.change(screen.getByRole('textbox',{name:'Source asset amount'}),{target:{value:'0.2'}});
 await waitFor(()=>expect(machine.getStore().context.quote).toMatchObject({amountIn:'200000'}),{timeout:5000});
 expect(fetchQuote.mock.calls.some(([request])=>request.amount==='200000')).toBe(true);
 expect(machine.getStore().context).toMatchObject({state:'quote_success_internal',walletAddress:owner,transferStatus:{status:'idle'},sourceToken:{assetId:source.assetId},targetToken:{assetId:target.assetId}});
 expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
 expect((screen.getByRole('button',{name:'Approve terms and request swap signature'}) as HTMLButtonElement).disabled).toBe(true);
 expect(localStorage.getItem(budgetKey)).toBe(budget);expect(sign).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
},15000);
it.each(['409','changed','busy','missing'] as const)('%s acknowledgement never resets another or unconfirmed recovery or grants signing',async outcome=>{
 const {budget,network,arrival,sign,send}=await prepare(outcome);
 await screen.findByText(outcome==='409'?'Arrival has not yet been confirmed by the server. No repeat transfer is needed.':'The saved transaction changed in another window. Reload the page; repeat transfers are blocked.');
 expect(machine.getStore().context.transferStatus.status).toBe('error');
 if(outcome==='missing')expect(localStorage.getItem(pendingKey)).toBeNull();else expect(JSON.parse(localStorage.getItem(pendingKey)!).eventId).toBe(outcome==='changed'?'other-operation':j.eventId);
 expect(localStorage.getItem(budgetKey)).toBe(budget);expect(sign).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(arrival).not.toHaveBeenCalled();
 expect((screen.getByRole('textbox',{name:'Source asset amount'}) as HTMLInputElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Approve terms and request swap signature'}));
 expect(network.mock.calls.every(([path])=>path==='/api/auth/session'||path==='/api/events')).toBe(true);
},15000);
it('valid startup recovery can complete and focus does not forever fence the next approved quote',async()=>{
 const {sign,send,budget,arrival}=await prepare('ok',false,undefined,true);
 await screen.findByText('The server has confirmed arrival.');
 expect(arrival).toHaveBeenCalledTimes(1);expect(localStorage.getItem(pendingKey)).toBeNull();
 act(()=>window.dispatchEvent(new Event('focus')));
 fireEvent.change(screen.getByRole('combobox',{name:'Source asset'}),{target:{value:`${source.assetId}|intents`}});
 fireEvent.change(screen.getByRole('textbox',{name:'Source asset amount'}),{target:{value:'0.2'}});
 await waitFor(()=>expect(machine.getStore().context.quote).toMatchObject({amountIn:'200000'}),{timeout:5000});
 const quote=machine.getStore().context.quote!;
 // Controlled authoritative status response via the actual SDK cache. No signer
 // is invoked: test only that verified recovery does not poison future consent.
 act(()=>activeCache.setQueryData(['oneClickExecutionStatus','offline-next'],{status:'PENDING_DEPOSIT',quoteResponse:{quote:{...quote,minAmountOut:'290'},quoteRequest:{dry:false,depositType:'INTENTS',refundType:'INTENTS',recipientType:'INTENTS',recipient:owner,refundTo:owner,originAsset:source.assetId,destinationAsset:target.assetId,slippageTolerance:100,appFees:quote.appFees ?? []}}}));
 await screen.findByText('0.0000029');
 fireEvent.click(screen.getByRole('checkbox'));
 await waitFor(()=>expect((screen.getByRole('button',{name:'Approve terms and request swap signature'}) as HTMLButtonElement).disabled).toBe(false));
 expect(localStorage.getItem(budgetKey)).toBe(budget);expect(sign).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
},15000);
it('a preactivation missing/replaced recovery snapshot stays fenced through the second lazy import and an unrelated verified arrival',async()=>{
 const {sign,send,budget,arrival}=await prepare('ok',false,{[owner]:JSON.stringify({...j,eventId:'preactivation-original'})});
 // A permanent startup fence may retain its warning after a separate verified
 // arrival. Assert the authoritative receipt/removal, not transient UI wording.
 await waitFor(()=>expect(arrival).toHaveBeenCalledTimes(1));expect(localStorage.getItem(pendingKey)).toBeNull();
 await screen.findByText(/A saved recovery record disappeared or changed before the wallet module loaded/);
 fireEvent.change(screen.getByRole('combobox',{name:'Source asset'}),{target:{value:`${source.assetId}|intents`}});
 fireEvent.change(screen.getByRole('textbox',{name:'Source asset amount'}),{target:{value:'0.2'}});
 await waitFor(()=>expect(machine.getStore().context.quote).toMatchObject({amountIn:'200000'}),{timeout:5000});
 fireEvent.click(screen.getByRole('checkbox'));
 expect((screen.getByRole('button',{name:'Approve terms and request swap signature'}) as HTMLButtonElement).disabled).toBe(true);
 expect(localStorage.getItem(budgetKey)).toBe(budget);expect(sign).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
},15000);
