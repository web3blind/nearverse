// @vitest-environment jsdom
import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {useQueryClient} from '@tanstack/react-query';
import {WidgetConfigProvider} from '@aurora-is-near/intents-swap-widget/config';
import {fireEvent as sdkEvent} from '@aurora-is-near/intents-swap-widget/machine';
import {HeadlessConverter} from '../src/sdk/HeadlessConverter';
import type {PendingJourney} from '../src/sdk/safety';
Object.defineProperty(window,'matchMedia',{writable:true,value:()=>({matches:false,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()})});
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
const journey=(owner:string,id:string):PendingJourney=>({eventId:id,systemId:'btc-basalt',accountId:owner,depositAddress:'deposit-'+id,originAsset:'nep141:wrap.near',destinationAsset:'nep141:nbtc.bridge.near',amountIn:'100',amountOut:'200',minAmountOut:'190'});
function status(j:PendingJourney,value:string){return {status:value,quoteResponse:{quoteRequest:{originAsset:j.originAsset,destinationAsset:j.destinationAsset,recipient:j.accountId,refundTo:j.accountId,recipientType:'INTENTS'},quote:{depositAddress:j.depositAddress,amountIn:j.amountIn,amountOut:j.amountOut,minAmountOut:j.minAmountOut}},swapDetails:{amountIn:j.amountIn,amountOut:j.amountOut}};}
function Seed({journeys,states,wallets}:{journeys:PendingJourney[];states:string[];wallets:{near:string}}){const cache=useQueryClient();for(const [index,j] of journeys.entries())cache.setQueryData(['oneClickExecutionStatus',j.depositAddress],status(j,states[index]));cache.setQueryData(['walletBalances',wallets],{'native-near-near':'1000000000000000000000001','nep141:usdt.tether-token.near-near':'12345678'});return null;}
function mount(owner:string,journeys:PendingJourney[],states:string[],onArrival=vi.fn()){
 const element=(account:string)=><WidgetConfigProvider config={{connectedWallets:{near:account}}}><Seed journeys={journeys} states={states} wallets={{near:account}}/><HeadlessConverter preview={false} targetAsset="BTC" systemId="btc-basalt" onArrival={onArrival}/></WidgetConfigProvider>;
 return {view:render(element(owner)),element,onArrival};
}
function sessionFetch(owner:()=>string,events?:(init?:RequestInit)=>Promise<Response>){vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{if(path==='/api/auth/session')return Response.json({accountId:owner()});if(path==='/api/events'&&events)return events(init);throw new Error('Unexpected fixture request '+path);}));}
describe('actual SDK cache + recovery UI with controlled external responses',()=>{
 it('late account A arrival never clears B pending record or calls B arrival callback',async()=>{
  const a=journey('alice.near','race-a');const b=journey('bob.near','race-b');localStorage.setItem('nearverse:pending:alice.near',JSON.stringify(a));localStorage.setItem('nearverse:pending:bob.near',JSON.stringify(b));
  let owner='alice.near';let release!:(r:Response)=>void;const deferred=new Promise<Response>(r=>{release=r;});sessionFetch(()=>owner,()=>deferred);
  const {view,element,onArrival}=mount(owner,[a,b],['SUCCESS','PROCESSING']);
  const verify=await screen.findByRole('button',{name:'Verify arrival with the server'});await waitFor(()=>expect((verify as HTMLButtonElement).disabled).toBe(false));fireEvent.click(verify);
  owner='bob.near';view.rerender(element(owner));await screen.findByText(/Transaction address: deposit-race-b/);
  await act(async()=>{release(Response.json({event:{eventId:a.eventId,type:'arrival'}}));await deferred;});
  expect(screen.getByText(/Transaction address: deposit-race-b/)).toBeTruthy();expect(JSON.parse(localStorage.getItem('nearverse:pending:bob.near')!).eventId).toBe(b.eventId);expect(onArrival).not.toHaveBeenCalled();
 });
 it.each(['REFUNDED','FAILED'])('requires explicit acknowledgement for %s, clears recovery without granting arrival',async terminal=>{
  const j=journey('alice.near','terminal-'+terminal);localStorage.setItem('nearverse:pending:alice.near',JSON.stringify(j));sessionFetch(()=>j.accountId);
  const {onArrival}=mount(j.accountId,[j],[terminal]);
  const acknowledge=await screen.findByRole('button',{name:'Acknowledge outcome and close recovery without arrival'});expect(localStorage.getItem('nearverse:pending:alice.near')).not.toBeNull();fireEvent.click(acknowledge);
  await waitFor(()=>expect(localStorage.getItem('nearverse:pending:alice.near')).toBeNull());expect(screen.queryByText(/Transaction address:/)).toBeNull();expect(onArrival).not.toHaveBeenCalled();
 });
 it.each(['PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','PROCESSING','UNKNOWN'])('never clears %s recovery, including legacy signatureRejected records',async pendingStatus=>{
  const j={...journey('alice.near','rejected'),signatureRejected:true};localStorage.setItem('nearverse:pending:alice.near',JSON.stringify(j));sessionFetch(()=>j.accountId);
  const {onArrival}=mount(j.accountId,[j],[pendingStatus]);
  await screen.findByText(/Transaction address: deposit-rejected/);
  expect(screen.queryByRole('button',{name:'Acknowledge outcome and close recovery without arrival'})).toBeNull();
  expect(JSON.parse(localStorage.getItem('nearverse:pending:alice.near')!)).toEqual(j);
  expect((screen.getByRole('button',{name:'Approve terms and request swap signature'}) as HTMLButtonElement).disabled).toBe(true);
  expect(onArrival).not.toHaveBeenCalled();
 });
 it('journal deletion suppresses an in-flight local arrival response and retains financial recovery',async()=>{
  const j=journey('alice.near','deleted');localStorage.setItem('nearverse:pending:alice.near',JSON.stringify(j));let release!:(r:Response)=>void;const deferred=new Promise<Response>(r=>{release=r;});sessionFetch(()=>j.accountId,()=>deferred);const {onArrival}=mount(j.accountId,[j],['SUCCESS']);
  const verify=await screen.findByRole('button',{name:'Verify arrival with the server'});await waitFor(()=>expect((verify as HTMLButtonElement).disabled).toBe(false));fireEvent.click(verify);
  act(()=>{localStorage.setItem('nearverse:journal-deleted:alice.near','new-revision');window.dispatchEvent(new CustomEvent('nearverse:journal-deleted',{detail:{accountId:j.accountId}}));});
  await act(async()=>{release(Response.json({event:{eventId:j.eventId}}));await deferred;});
  expect(onArrival).not.toHaveBeenCalled();expect(JSON.parse(localStorage.getItem('nearverse:pending:alice.near')!).eventId).toBe(j.eventId);expect(localStorage.getItem('nearverse:journal-deleted:alice.near')).toBe('new-revision');expect((screen.getByRole('button',{name:'Verify arrival with the server'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('displays exact native and wallet-USDT balances from actual SDK query-cache keys',async()=>{
  sessionFetch(()=>'alice.near');mount('alice.near',[],[]);await screen.findByText(/History: signed in/);
  const base={blockchain:'near' as const,price:1,icon:'',isIntent:false,chainName:'NEAR',name:'fixture'};
  act(()=>sdkEvent('tokenSelect',{variant:'source',token:{...base,assetId:'native-near',symbol:'NEAR',decimals:24}}));await screen.findByText(/Available balance: 1\.000000000000000000000001/);
  act(()=>sdkEvent('tokenSelect',{variant:'source',token:{...base,assetId:'nep141:usdt.tether-token.near',symbol:'USDT',decimals:6}}));expect(await screen.findByText(/Available balance: 12\.345678/)).toBeTruthy();
 });
});
