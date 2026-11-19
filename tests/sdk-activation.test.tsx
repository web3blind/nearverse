// @vitest-environment jsdom
import React,{useEffect,useLayoutEffect,useState} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {HeadlessConverter} from '../src/sdk/HeadlessConverter';
import type {FinancialPanelProps} from '../src/sdk/FinancialPanel';
// Real converter and its safety/ledger code; only SDK hooks and wallet/network
// boundaries are controlled. The second import is a manually released UI gate.
const h=vi.hoisted(()=>({integration:false,finish:()=>{},layout:()=>{},config:{} as Record<string,unknown>,ctx:{} as Record<string,unknown>,status:{} as Record<string,unknown>,make:vi.fn(),sign:vi.fn(),send:vi.fn()}));
vi.mock('@aurora-is-near/intents-swap-widget/config',()=>({useConfig:()=>h.config}));
vi.mock('@aurora-is-near/intents-swap-widget/machine',()=>({useStoreSideEffects:()=>{},useUnsafeSnapshot:()=>({ctx:h.ctx}),fireEvent:()=>{},machine:{getStore:()=>({context:h.ctx})}}));
vi.mock('@aurora-is-near/intents-swap-widget/hooks',()=>({useAllTokens:()=>({tokens:[]}),useWalletConnection:()=>({}),useWalletBalance:()=>({walletBalance:{}}),useIntentsBalance:()=>({intentBalances:{}}),useIntentsAccountType:()=>({intentsAccountType:'near'}),useOneClickExecutionStatus:()=>({data:h.status,isError:false}),useMakeTransfer:()=>({make:h.make})}));
import {useFinancialActivation} from '../src/sdk/financialActivation';
const observed=vi.hoisted(()=>({mounts:0}));
vi.mock('../src/sdk/FinancialPanel',()=>({FinancialPanel:(props:FinancialPanelProps)=>{
  const {systemId,connectRequest,activationRecoveryBlocked}=props;
  const [ready,setReady]=useState(false);
  // Parent layout runs after the child render/mount probe (and child layout),
  // but before either passive recovery effect. Not a pre-render gate mutation.
  useLayoutEffect(()=>{if(ready)h.layout();},[ready]);
  const [consent,setConsent]=useState(false);useEffect(()=>{observed.mounts++;},[]);useEffect(()=>{setConsent(false);},[systemId]);
  if(h.integration)return ready?<HeadlessConverter {...props} apiKey="offline-fence" targetAsset="BTC" systemId="btc-basalt"/>:<button onClick={()=>{h.finish();setReady(true);}}>Finish wallet loading</button>;
  return <div><output data-testid="request">{connectRequest}</output><output data-testid="blocked">{String(activationRecoveryBlocked)}</output><output>{systemId}</output><label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Fixture consent</label></div>;
}}));
function Shell({beacon='near-lada'}:{beacon?:string}){
  const activation=useFinancialActivation();
  const {Panel,activate,loading,error,recovery,connectRequest,activationRecoveryBlocked}=activation;
  return <><button disabled={loading} onClick={()=>void activate()}>Connect NEAR wallet</button><p role="status">{loading?'Loading wallet module':recovery.message}</p>{error && <p role="alert">{error}</p>}{Panel && <Panel {...activation} preview={false} systemId={beacon} connectRequest={connectRequest} activationRecoveryBlocked={activationRecoveryBlocked}/>}</>;
}
const oldLocks=Object.getOwnPropertyDescriptor(navigator,'locks');
beforeEach(()=>{localStorage.clear();observed.mounts=0;h.integration=false;h.finish=()=>{};h.layout=()=>{};vi.clearAllMocks();
  const source={assetId:'native-near',isIntent:false,decimals:24,blockchain:'near',symbol:'NEAR',price:3,icon:'',name:'NEAR',chainName:'NEAR'};
  const target={...source,assetId:'nep141:nbtc.bridge.near',isIntent:true,decimals:8,symbol:'BTC'};
  const quote={type:'QUOTE_REAL_WITH_AMOUNT',dry:false,depositAddress:'deposit.near',amountIn:'100000000000000000000000',amountInUsd:'0.3',amountOut:'200',deadline:'2099-01-01T00:00:00Z'};
  h.ctx={sourceToken:source,targetToken:target,quote,state:'idle'};
  h.config={connectedWallets:{near:'alice.near'},providers:{near:()=>({signMessage:h.sign,signAndSendTransactions:h.send})},slippageTolerance:100,appFees:[]};
  h.status={status:'PENDING_DEPOSIT',quoteResponse:{quote:{...quote,minAmountOut:'190'},quoteRequest:{dry:false,slippageTolerance:100,appFees:[],deadline:'2099-01-01T01:00:00Z',amount:quote.amountIn,swapType:'EXACT_INPUT',depositType:'ORIGIN_CHAIN',refundType:'ORIGIN_CHAIN',recipientType:'INTENTS',recipient:'alice.near',refundTo:'alice.near',originAsset:'nep141:wrap.near',destinationAsset:target.assetId}}};
  Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn()}});
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>{if(path==='/api/auth/session')return Response.json({accountId:'alice.near'});throw Error('No funding/network request is permitted');}));
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();if(oldLocks)Object.defineProperty(navigator,'locks',oldLocks);else Reflect.deleteProperty(navigator,'locks');});
describe('explicit financial activation lifetime',()=>{
  it('restores an earlier wallet quietly, first click requests connect, beacon changes do not remount or reconnect',async()=>{
    localStorage.setItem('selected-wallet','meteor-wallet');
    localStorage.setItem('nearverse:cached-account','alice.near');
    const view=render(<Shell/>);
    // The module loads for session restore without a connect request (no selector, no signature).
    await waitFor(()=>expect(observed.mounts).toBe(1));expect(screen.getByTestId('request').textContent).toBe('0');
    const button=screen.getByRole('button',{name:'Connect NEAR wallet'}) as HTMLButtonElement;expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(()=>expect(screen.getByTestId('request').textContent).toBe('1'));
    fireEvent.click(screen.getByLabelText('Fixture consent'));
    view.rerender(<Shell beacon="btc-basalt"/>);
    expect(observed.mounts).toBe(1);expect(screen.getByTestId('request').textContent).toBe('1');
    expect((screen.getByLabelText('Fixture consent') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(button);await waitFor(()=>expect(screen.getByTestId('request').textContent).toBe('2'));expect(observed.mounts).toBe(1);
  });
  it.each(['missing','replaced'])('latches %s preactivation recovery instead of silently allowing new actions',async kind=>{
    const key='nearverse:pending:alice.near';localStorage.setItem(key,JSON.stringify({accountId:'alice.near',eventId:'original'}));
    render(<Shell/>);expect(screen.getByRole('status').textContent).toContain('needs recovery');expect(observed.mounts).toBe(0);
    if(kind==='missing')localStorage.removeItem(key);else localStorage.setItem(key,JSON.stringify({accountId:'alice.near',eventId:'replacement'}));
    fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    await waitFor(()=>expect(screen.getByTestId('blocked').textContent).toBe('true'));
  });
});

// These are offline admission regressions, not actual dynamic-chunk or wallet QA.
const foreignKey='nearverse:pending:bob.near';
function writeForeign(eventId='first'){localStorage.setItem(foreignKey,JSON.stringify({accountId:'bob.near',eventId}));}
async function finishLoading(){
  fireEvent.click(await screen.findByRole('button',{name:'Finish wallet loading'}));
  await screen.findByText(/History: signed in/);
  fireEvent.click(screen.getByRole('checkbox'));
  return screen.getByRole('button',{name:'Approve terms and request swap signature'}) as HTMLButtonElement;
}
function assertNoFunding(button:HTMLButtonElement,expectedPending:string|null=null){
  expect(button.disabled).toBe(true);fireEvent.click(button);
  expect(h.make).not.toHaveBeenCalled();expect(h.sign).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
  expect(localStorage.getItem('nearverse:pending:alice.near')).toBe(expectedPending);
  expect(localStorage.getItem('nearverse:qa-budget:alice.near')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.every(([path])=>path==='/api/auth/session')).toBe(true);
}
function atProbe(number:number,action:()=>void){
  const getter=Object.getOwnPropertyDescriptor(Storage.prototype,'length')!.get!;let calls=0;
  vi.spyOn(Storage.prototype,'length','get').mockImplementation(function(this:Storage){if(++calls===number)action();return getter.call(this);});
}
describe('monotonic recovery admission through lazy loading',()=>{
  it('retains recovery first seen inside the final callback probe until its exact snapshot is owned',async()=>{
    h.integration=true;
    const key='nearverse:pending:bob.near';
    const raw=JSON.stringify({accountId:'bob.near',eventId:'final-callback-first-seen'});
    let inserted=false,removed=false;
    h.layout=()=>{
      // Child check sees empty storage first. Only the parent's final callback
      // probe sees the record; it disappears at that probe's loop completion.
      const getter=Object.getOwnPropertyDescriptor(Storage.prototype,'length')!.get!;let reads=0;
      vi.spyOn(Storage.prototype,'length','get').mockImplementation(function(this:Storage){
        reads++;
        if(reads===2){localStorage.setItem(key,raw);inserted=true;}
        if(reads===3){localStorage.removeItem(key);removed=true;}
        return getter.call(this);
      });
    };
    render(<Shell/>);fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    const button=await finishLoading();
    expect(inserted).toBe(true);expect(removed).toBe(true);expect(localStorage.getItem(key)).toBeNull();
    act(()=>window.dispatchEvent(new Event('focus')));
    await screen.findByText(/A saved recovery record disappeared or changed before the wallet module loaded/);
    assertNoFunding(button);
  });
  it('does not hand off mount-only pending while the account is still restoring',async()=>{
    h.integration=true;h.config={...h.config,connectedWallets:{}};
    const key='nearverse:pending:alice.near';
    const raw=JSON.stringify({accountId:'alice.near',eventId:'still-restoring',systemId:'btc-basalt',depositAddress:'saved.near',originAsset:'nep141:wrap.near',destinationAsset:'nep141:nbtc.bridge.near',amountIn:'100',amountOut:'200',minAmountOut:'190'});
    h.finish=()=>localStorage.setItem(key,raw);
    const view=render(<Shell/>);fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    fireEvent.click(await screen.findByRole('button',{name:'Finish wallet loading'}));
    await screen.findByText(/NEAR account: not connected/);
    // The first passive check has seen valid bytes, but no live pending state
    // has accepted them. Deletion now must still compare the mount witness.
    act(()=>{localStorage.removeItem(key);window.dispatchEvent(new Event('focus'));});
    act(()=>{h.config={...h.config,connectedWallets:{near:'alice.near'}};});
    view.rerender(<Shell/>);await screen.findByText(/History: signed in/);
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByText(/A saved recovery record disappeared or changed before the wallet module loaded/);
    assertNoFunding(screen.getByRole('button',{name:'Approve terms and request swap signature'}) as HTMLButtonElement);
  });
  it('StrictMode passive cleanup/reinstall preserves clean admission without wallet calls',async()=>{
    h.integration=true;render(<React.StrictMode><Shell/></React.StrictMode>);
    fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    const button=await finishLoading();act(()=>window.dispatchEvent(new Event('focus')));
    expect(button.disabled).toBe(false);expect(h.make).not.toHaveBeenCalled();expect(h.sign).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
    expect(localStorage.getItem('nearverse:qa-budget:alice.near')).toBeNull();
  });
  it.each(['startup','mount'] as const)('%s first-seen bytes survive parent layout DELETE before passive ownership',async firstSeen=>{
    h.integration=true;
    const key='nearverse:pending:alice.near';
    const raw=JSON.stringify({accountId:'alice.near',eventId:'layout-original',systemId:'btc-basalt',depositAddress:'saved.near',originAsset:'nep141:wrap.near',destinationAsset:'nep141:nbtc.bridge.near',amountIn:'100',amountOut:'200',minAmountOut:'190'});
    if(firstSeen==='startup')localStorage.setItem(key,raw);else h.finish=()=>localStorage.setItem(key,raw);
    h.layout=()=>localStorage.removeItem(key);
    render(<Shell/>);fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    const button=await finishLoading();
    await screen.findByText(/A saved recovery record disappeared or changed before the wallet module loaded/);
    act(()=>window.dispatchEvent(new Event('focus')));assertNoFunding(button);
  });
  it.each(['startup','mount'] as const)('%s first-seen bytes survive parent layout REPLACE before passive ownership',async firstSeen=>{
    h.integration=true;
    const key='nearverse:pending:alice.near';
    const saved={accountId:'alice.near',eventId:'layout-original',systemId:'btc-basalt',depositAddress:'saved.near',originAsset:'nep141:wrap.near',destinationAsset:'nep141:nbtc.bridge.near',amountIn:'100',amountOut:'200',minAmountOut:'190'};
    const raw=JSON.stringify(saved),replacement=JSON.stringify({...saved,eventId:'layout-replacement'});
    if(firstSeen==='startup')localStorage.setItem(key,raw);else h.finish=()=>localStorage.setItem(key,raw);
    h.layout=()=>localStorage.setItem(key,replacement);
    render(<Shell/>);fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    const button=await finishLoading();
    await screen.findByText(/A saved recovery record disappeared or changed before the wallet module loaded/);
    assertNoFunding(button,replacement);
    act(()=>{localStorage.removeItem(key);window.dispatchEvent(new Event('focus'));});assertNoFunding(button);
  });
  it.each(['DELETE','REPLACE'] as const)('mount-only recovery with account initially null retains %s through asynchronous restore',async mutation=>{
    h.integration=true;h.config={...h.config,connectedWallets:{}};
    const key='nearverse:pending:alice.near';
    const raw=JSON.stringify({accountId:'alice.near',eventId:'awaiting-restore',systemId:'btc-basalt',depositAddress:'saved.near',originAsset:'nep141:wrap.near',destinationAsset:'nep141:nbtc.bridge.near',amountIn:'100',amountOut:'200',minAmountOut:'190'});
    h.finish=()=>localStorage.setItem(key,raw);
    h.layout=()=>{if(mutation==='DELETE')localStorage.removeItem(key);else localStorage.setItem(key,raw.replace('awaiting-restore','replacement'));};
    const view=render(<Shell/>);fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    fireEvent.click(await screen.findByRole('button',{name:'Finish wallet loading'}));
    await screen.findByText(/NEAR account: not connected/);
    await screen.findByText(/A saved recovery record disappeared or changed before the wallet module loaded/);
    act(()=>{localStorage.removeItem(key);h.config={...h.config,connectedWallets:{near:'alice.near'}};});
    view.rerender(<Shell/>);await screen.findByText(/History: signed in/);
    fireEvent.click(screen.getByRole('checkbox'));
    assertNoFunding(screen.getByRole('button',{name:'Approve terms and request swap signature'}) as HTMLButtonElement);
  });
  it.each([2,3])('clean startup then pending first seen at probe %s survives second-boundary deletion',async probe=>{
    h.integration=true;atProbe(probe,()=>writeForeign());render(<Shell/>);
    h.finish=()=>localStorage.removeItem(foreignKey);
    fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    assertNoFunding(await finishLoading());
  });
  it.each([2,3])('clean startup then pending first seen at probe %s survives second-boundary replacement',async probe=>{
    h.integration=true;atProbe(probe,()=>writeForeign());render(<Shell/>);
    h.finish=()=>writeForeign('replacement');
    fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    const button=await finishLoading();
    await screen.findByText(/A saved recovery record disappeared or changed before the wallet module loaded/);
    // Remove the replacement after mount too: the first-seen mutation must remain latched.
    act(()=>{localStorage.removeItem(foreignKey);window.dispatchEvent(new Event('focus'));});
    assertNoFunding(button);
  });
  it.each([[2,'denied'],[3,'denied'],[2,'corrupt'],[3,'corrupt']] as const)('transient %s/%s cannot become clean admission',async(probe,kind)=>{
    h.integration=true;atProbe(probe,()=>{if(kind==='denied')throw new DOMException('Denied','SecurityError');localStorage.setItem(foreignKey,'{');});
    render(<Shell/>);h.finish=()=>localStorage.removeItem(foreignKey);
    fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    assertNoFunding(await finishLoading());
  });
  it.each(['denied','corrupt'])('mount-time %s storage latches even with an empty old snapshot',async kind=>{
    h.integration=true;render(<Shell/>);fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    h.finish=()=>{if(kind==='corrupt')localStorage.setItem(foreignKey,'{');else vi.spyOn(Storage.prototype,'length','get').mockImplementationOnce(()=>{throw new DOMException('Denied','SecurityError');});};
    const button=await finishLoading();
    act(()=>{localStorage.removeItem(foreignKey);window.dispatchEvent(new Event('focus'));});
    assertNoFunding(button);
  });
  it.each(['__proto__','','Alice.near','a..near'])('malformed owner %j cannot lose its fence by deletion or replacement',async owner=>{
    h.integration=true;const key=`nearverse:pending:${owner}`;
    localStorage.setItem(key,JSON.stringify({accountId:owner,eventId:'unknown'}));render(<Shell/>);
    expect(screen.getByRole('status').textContent).toContain('unavailable or corrupted');
    fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    h.finish=()=>localStorage.removeItem(key);
    const button=await finishLoading();assertNoFunding(button);
    act(()=>{localStorage.setItem(key,JSON.stringify({accountId:owner,eventId:'replacement'}));window.dispatchEvent(new Event('focus'));localStorage.removeItem(key);window.dispatchEvent(new Event('focus'));});
    assertNoFunding(button);
  });
  it.each([{accountId:'bob.near',eventId:''},{accountId:'alice.near',eventId:'unknown'}])('malformed metadata %j first seen at activation remains fenced after deletion',async saved=>{
    h.integration=true;atProbe(2,()=>localStorage.setItem(foreignKey,JSON.stringify(saved)));
    render(<Shell/>);h.finish=()=>localStorage.removeItem(foreignKey);
    fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    assertNoFunding(await finishLoading());
  });
  it('observes first-seen pending on focus while the second boundary is still loading',async()=>{
    h.integration=true;render(<Shell/>);fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    await screen.findByRole('button',{name:'Finish wallet loading'});
    act(()=>{writeForeign();window.dispatchEvent(new Event('focus'));});
    h.finish=()=>localStorage.removeItem(foreignKey);assertNoFunding(await finishLoading());
  });
  it('clean connection admits explicit terms without funding automatically',async()=>{
    h.integration=true;render(<Shell/>);fireEvent.click(screen.getByRole('button',{name:'Connect NEAR wallet'}));
    const button=await finishLoading();expect(button.disabled).toBe(false);
    expect(h.make).not.toHaveBeenCalled();expect(h.sign).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
  });
});

