// @vitest-environment jsdom
import React, {useEffect} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NearConnector} from '@hot-labs/near-connect';
import type {NearWalletBase} from '@hot-labs/near-connect/build/types/wallet';
import {useConfig} from '@aurora-is-near/intents-swap-widget/config';
import {NearWalletProvider} from '../src/sdk/NearWalletProvider';
import {probeRecovery} from '../src/sdk/recoveryProbe';
let connector:NearConnector;
let mounts=0;
let current:ReturnType<typeof useConfig>;
function Probe(){current=useConfig();useEffect(()=>{mounts++;},[]);return <output>{current.connectedWallets.near || 'disconnected'}</output>;}
const wallet={signMessage:vi.fn(),signAndSendTransactions:vi.fn(),getAccounts:vi.fn()} as unknown as NearWalletBase;
const manifest={id:'meteor-wallet',name:'Meteor Wallet',type:'sandbox',platform:['web'],version:'offline',executor:'https://example.invalid/offline-only.js',website:'https://meteorwallet.app',icon:'',description:'Explicit offline manifest fixture',permissions:{},features:{signMessage:true,signAndSendTransactions:true,signInWithoutAddKey:true,mainnet:true}};
beforeEach(()=>{
  localStorage.clear();mounts=0;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({wallets:[manifest],version:'1'}))));
  Object.defineProperty(window,'matchMedia',{writable:true,value:()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})});
  vi.spyOn(NearConnector.prototype,'getConnectedWallet').mockImplementation(async function(this:NearConnector){connector=this;throw new Error('No session');});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('NEAR connector and real core provider contract',()=>{
  it('opens accessible NEAR selector once after activation, publishes original native provider, retains mount across game changes and isolates preview',async()=>{
    const connect=vi.spyOn(NearConnector.prototype,'connect').mockResolvedValue(wallet);
    const config={appFees:[]};
    const view=render(<NearWalletProvider config={config} connectRequest={1}><Probe/></NearWalletProvider>);
    await screen.findByRole('dialog',{name:'Choose a NEAR wallet'});
    expect(connect).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{name:'Meteor Wallet'}));
    await waitFor(()=>expect(connect).toHaveBeenCalledTimes(1));expect(connect).toHaveBeenCalledWith('meteor-wallet');
    await act(async()=>{connector.events.emit('wallet:signIn',{wallet,accounts:[{accountId:'alice.near',publicKey:'ed25519:fixture'}],success:true});});
    await screen.findByText('alice.near');
    expect(current.providers?.near?.()).toBe(wallet);
    expect(Object.keys(current.providers || {})).toEqual(['near']);
    expect(wallet.signMessage).not.toHaveBeenCalled();expect(wallet.signAndSendTransactions).not.toHaveBeenCalled();
    view.rerender(<NearWalletProvider config={config} connectRequest={1}><Probe/></NearWalletProvider>);
    expect(mounts).toBe(1);expect(connect).toHaveBeenCalledTimes(1);
    view.rerender(<NearWalletProvider config={config} connectRequest={1} preview><Probe/></NearWalletProvider>);
    await screen.findByText('disconnected');expect(current.providers?.near).toBeUndefined();
    view.rerender(<NearWalletProvider config={config} connectRequest={1}><Probe/></NearWalletProvider>);
    await screen.findByText('alice.near');expect(mounts).toBe(1);
    await act(async()=>{connector.events.emit('wallet:signIn',{wallet,accounts:[{accountId:'bob.near',publicKey:'ed25519:fixture'}],success:true});});
    await screen.findByText('bob.near');
    await act(async()=>{connector.events.emit('wallet:signOut',{success:true});});
    await screen.findByText('disconnected');expect(current.providers?.near).toBeUndefined();
    await act(async()=>{connector.events.emit('wallet:signIn',{wallet,accounts:[{accountId:'late.near',publicKey:'ed25519:fixture'}],success:true});});
    expect(screen.getByText('disconnected')).toBeTruthy();expect(current.providers?.near).toBeUndefined();
  });
  it('removes signing capability immediately during pending sign-out',async()=>{
    let finish!:()=>void;
    const disconnect=vi.spyOn(NearConnector.prototype,'disconnect').mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    vi.spyOn(NearConnector.prototype,'getConnectedWallet').mockResolvedValue({wallet,accounts:[{accountId:'alice.near',publicKey:'ed25519:fixture'}]});
    render(<NearWalletProvider config={{}}><Probe/></NearWalletProvider>);await screen.findByText('alice.near');
    let completion:unknown;
    await act(async()=>{completion=current.onWalletSignout?.('near');});
    expect(screen.getByText('disconnected')).toBeTruthy();expect(current.providers?.near).toBeUndefined();expect(disconnect).toHaveBeenCalledTimes(1);
    await act(async()=>{finish();await completion;});
    expect(wallet.signMessage).not.toHaveBeenCalled();expect(wallet.signAndSendTransactions).not.toHaveBeenCalled();
  });
  it('restores through official account lookup without opening or signing and shows an accessible connection retry',async()=>{
    const connect=vi.spyOn(NearConnector.prototype,'connect').mockRejectedValue(new Error('Offline cancellation'));
    vi.spyOn(NearConnector.prototype,'getConnectedWallet').mockResolvedValue({wallet,accounts:[{accountId:'alice.near',publicKey:'ed25519:fixture'}]});
    render(<NearWalletProvider config={{}}><Probe/></NearWalletProvider>);
    await screen.findByText('alice.near');expect(connect).not.toHaveBeenCalled();
    await act(async()=>{await current.onWalletSignin?.();});
    fireEvent.click(await screen.findByRole('button',{name:'Meteor Wallet'}));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('No swap signature');
    fireEvent.click(screen.getByRole('button',{name:'Retry NEAR wallet connection'}));
    fireEvent.click(await screen.findByRole('button',{name:'Meteor Wallet'}));
    await waitFor(()=>expect(connect).toHaveBeenCalledTimes(2));
    expect(wallet.signMessage).not.toHaveBeenCalled();
  });
});
describe('startup recovery without SDK or cached-account activation',()=>{
  it('finds all accounts and fails closed on corrupt, missing while enumerating, replaced-owner or denied storage',()=>{
    expect(probeRecovery().blocked).toBe(false);
    localStorage.setItem('nearverse:pending:alice.near',JSON.stringify({accountId:'alice.near',eventId:'operation-1'}));
    expect(probeRecovery().owners).toEqual(['alice.near']);
    localStorage.setItem('nearverse:pending:bob.near','{');const corrupt=probeRecovery();expect(corrupt.blocked).toBe(true);expect(corrupt.invalid).toBe(true);expect(corrupt.owners).toEqual(['alice.near']);expect(corrupt.entries['alice.near']).toBe(localStorage.getItem('nearverse:pending:alice.near'));expect(corrupt.entries['bob.near']).toBe('{');
    expect(probeRecovery({get length(){throw new Error('denied');}} as unknown as Storage).blocked).toBe(true);
    expect(probeRecovery({length:1,key:()=> 'nearverse:pending:alice.near',getItem:()=>null} as unknown as Storage).blocked).toBe(true);
    expect(probeRecovery({length:1,key:()=> 'nearverse:pending:alice.near',getItem:()=>JSON.stringify({accountId:'bob.near',eventId:'replacement'})} as unknown as Storage).blocked).toBe(true);
  });
});
