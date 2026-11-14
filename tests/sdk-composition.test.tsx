// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {cleanup, fireEvent as uiEvent, render, screen, waitFor} from '@testing-library/react';
import {FinancialPanel} from '../src/sdk/FinancialPanel';
import {WidgetConfigProvider} from '@aurora-is-near/intents-swap-widget/config';
import {useStoreSideEffects, useUnsafeSnapshot, fireEvent} from '@aurora-is-near/intents-swap-widget/machine';
import {useAllTokens, useWalletBalance} from '@aurora-is-near/intents-swap-widget/hooks';
Object.defineProperty(window,'matchMedia',{writable:true,value:vi.fn().mockImplementation(()=>({matches:false,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}))});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
function Probe(){
 useStoreSideEffects({listenTo:['syncConfig','checkWalletConnection','updateBalances','setSourceTokenBalance']});
 const {ctx}=useUnsafeSnapshot();const {tokens}=useAllTokens();const balance=useWalletBalance({});
 return <><output data-testid="state">{ctx.state}</output><output data-testid="tokens">{tokens.length}</output><output data-testid="balance">{Object.keys(balance.walletBalance).length}</output><button onClick={()=>fireEvent('reset',{clearWalletAddress:true})}>Reset machine</button></>;
}
function QuoteProbe({sourceAsset='nep141:wrap.near'}:{sourceAsset?:string}){
 useStoreSideEffects({listenTo:['syncConfig',['makeQuote',{type:'exact_in'}]]});
 const {ctx}=useUnsafeSnapshot();
 return <><output data-testid="quote-state">{ctx.quoteStatus}</output><output data-testid="dry">{ctx.quote?.dry ? 'dry' : 'none'}</output><button onClick={()=>{
 fireEvent('reset',{clearWalletAddress:true});
 const base={blockchain:'near' as const,price:1,icon:'',isIntent:false,chainName:'NEAR',name:'fixture'};
 fireEvent('tokenSelect',{variant:'source',token:{...base,assetId:sourceAsset,symbol:sourceAsset==='native-near'?'NEAR':'wNEAR',decimals:24}});
 fireEvent('tokenSelect',{variant:'target',token:{...base,assetId:'nep141:usdt.tether-token.near',symbol:'USDT',decimals:6,isIntent:true}});
 fireEvent('tokenSetAmount',{variant:'source',amount:'1000000000000000000000000'});
 }}>Request controlled dry quote</button></>;
}
describe('published SDK composition, not mock SDK',()=>{
 it('mounts actual provider, default BalanceRpcLoader, effects and cache hooks with no connected account',async()=>{
  render(<WidgetConfigProvider config={{connectedWallets:{},appFees:[]}}><Probe/></WidgetConfigProvider>);
  await waitFor(()=>expect(screen.getByTestId('state').textContent).toBeTruthy());
  expect(screen.getByTestId('tokens').textContent).toBe('0');
  expect(screen.getByTestId('balance').textContent).toBe('0');
 });
 it('routes UI input through actual SDK effects to controlled quote boundary, without connect or transfer',async()=>{
  const fetchQuote=vi.fn(async(_input:unknown)=>({minAmountIn:'1000000000000000000000000',minAmountOut:'1980000',amountIn:'1000000000000000000000000',amountOut:'2000000',amountInFormatted:'1',amountOutFormatted:'2',amountInUsd:'1',amountOutUsd:'2',timeEstimate:5}));
  render(<WidgetConfigProvider balanceViaRpc={false} config={{connectedWallets:{},fetchQuote,enableAccountAbstraction:true,appFees:[]}}><QuoteProbe/></WidgetConfigProvider>);
  uiEvent.click(screen.getByRole('button',{name:'Request controlled dry quote'}));
  await waitFor(()=>expect(fetchQuote).toHaveBeenCalled(),{timeout:5000});
  await waitFor(()=>expect(screen.getByTestId('dry').textContent).toBe('dry'));
  expect(fetchQuote.mock.calls[0]?.[0]).toMatchObject({dry:true,amount:'1000000000000000000000000'});
 });
 it('normalizes a native NEAR source exactly as the published SDK before upstream quote binding',async()=>{
  const fetchQuote=vi.fn(async(_input:unknown)=>({minAmountIn:'1000000000000000000000000',minAmountOut:'1980000',amountIn:'1000000000000000000000000',amountOut:'2000000',amountInFormatted:'1',amountOutFormatted:'2',amountInUsd:'1',amountOutUsd:'2',timeEstimate:5}));
  render(<WidgetConfigProvider balanceViaRpc={false} config={{connectedWallets:{},fetchQuote,enableAccountAbstraction:true,appFees:[]}}><QuoteProbe sourceAsset="native-near"/></WidgetConfigProvider>);
  uiEvent.click(screen.getByRole('button',{name:'Request controlled dry quote'}));
  await waitFor(()=>expect(fetchQuote).toHaveBeenCalled(),{timeout:5000});
  expect(fetchQuote.mock.calls[0]?.[0]).toMatchObject({dry:true,originAsset:'nep141:wrap.near',destinationAsset:'nep141:usdt.tether-token.near',depositType:'ORIGIN_CHAIN'});
 });
 it('keeps unavailable quotes explicit instead of manufacturing an executable route',async()=>{
  const fetchQuote=vi.fn(async()=>{throw new Error('Controlled route has no liquidity');});
  render(<WidgetConfigProvider balanceViaRpc={false} config={{connectedWallets:{},fetchQuote,enableAccountAbstraction:true,appFees:[]}}><QuoteProbe/></WidgetConfigProvider>);
  uiEvent.click(screen.getByRole('button',{name:'Request controlled dry quote'}));
  await waitFor(()=>expect(screen.getByTestId('quote-state').textContent).toBe('error'),{timeout:5000});
  expect(fetchQuote).toHaveBeenCalled();expect(screen.getByTestId('dry').textContent).toBe('none');
 });
 it('renders actual financial UI fail-closed without integration key, never connects a wallet in preview',async()=>{
  vi.stubEnv('VITE_AURORA_API_KEY','');
  render(<FinancialPanel preview targetAsset="BTC" systemId="fixture-system"/>);
  expect(screen.getByText(/The public Aurora integration key is not configured/)).toBeTruthy();
  expect((await screen.findByRole('button',{name:'Approve terms and request swap signature'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button',{name:'Connect NEAR wallet'})).toBeNull();
  expect(screen.getByRole('heading',{name:'NEAR Intents converter',level:2})).toBeTruthy();
  expect(screen.getByText('Preview: wallets and real swaps are disabled.')).toBeTruthy();
  expect(screen.queryByText(/SDK/i)).toBeNull();
  expect(screen.queryByText(/[А-Яа-яЁё]/)).toBeNull();
 });
});
