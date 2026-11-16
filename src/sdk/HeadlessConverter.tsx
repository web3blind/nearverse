import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useConfig } from '@aurora-is-near/intents-swap-widget/config';
import { fireEvent, machine, useStoreSideEffects, useUnsafeSnapshot } from '@aurora-is-near/intents-swap-widget/machine';
import { useAllTokens, useIntentsAccountType, useIntentsBalance, useMakeTransfer, useOneClickExecutionStatus, useWalletBalance, useWalletConnection } from '@aurora-is-near/intents-swap-widget/hooks';
import type { NearWalletBase, Token } from '@aurora-is-near/intents-swap-widget/types';
import { probeRecovery, observeRecovery, mergeRecovery } from './recoveryProbe';
import { supportedToken, targetAssetId } from '../assets';
import { boundRecoveryStatus, mayAcknowledge, canonicalMinimum as getCanonicalMinimum, upstreamAssetId, canConfirm, finalStatus, formatUnits, parseUnits, type PendingJourney } from './safety';
import type { FinancialPanelProps } from './FinancialPanel';
import { commitBudget, guardedNearWallet, routeFeeCost, readReserve, reserveCost } from './signing';
const tokenKey = (t:Token) => `${t.assetId}|${t.isIntent ? 'intents':'wallet'}`;
const tokenLabel = (t:Token) => `${t.symbol} · ${t.isIntent ? 'Intents (NEP-245)' : `wallet ${t.blockchain} (NEP-141 / native)`}`;
export function HeadlessConverter({ onRecoveryActivated,activationRecoveryEntries,activationRecoveryBlocked=false,preview,targetAsset,systemId,onAccountChange,onArrival,onHistorySession,apiKey }:FinancialPanelProps & {apiKey?:string}) {
  const config = useConfig();
  const [mountRecovery]=useState(()=>observeRecovery({entries:activationRecoveryEntries ?? Object.create(null),blocked:activationRecoveryBlocked},probeRecovery()));
  const startupRecovery=useRef(mountRecovery);
  const recoveryOwned=useRef(false);
  const loadedRecovery=useRef<{raw:string;journey:PendingJourney}|null>(null);
  const [startupRecoveryChanged,setStartupRecoveryChanged]=useState(mountRecovery.blocked);
  const activationBlocked=activationRecoveryBlocked || startupRecoveryChanged;
  useStoreSideEffects({listenTo:['syncConfig','updateBalances','checkWalletConnection','setSourceTokenBalance',...(apiKey && !preview ? [['makeQuote',{type:'exact_in',refetchQuoteInterval:15000}] as ['makeQuote',{type:'exact_in';refetchQuoteInterval:number}]] : [])]});
  const {ctx} = useUnsafeSnapshot();
  const {tokens} = useAllTokens();
  const {walletSignIn,walletSignOut} = useWalletConnection();
  const {walletBalance} = useWalletBalance(config.connectedWallets);
  const {intentBalances} = useIntentsBalance();
  const activeSigning=useRef<{journey:PendingJourney;source:Token;deadline:string;current:()=>boolean;wallet?:NearWalletBase}|null>(null);
  const providers=useMemo(()=>({...config.providers,near:config.providers?.near?()=>{
    const active=activeSigning.current;if(!active)throw new Error('No approved transaction is available for signing.');
    return active.wallet ??= guardedNearWallet(config.providers!.near!(),active.journey,active.source,active.deadline,active.current,open=>{walletOpen.current=open;});
  }:undefined}),[config.providers]);
  const {make:makeTransfer} = useMakeTransfer({providers,plugins:config.plugins});
  const {intentsAccountType}=useIntentsAccountType();
  // Standalone publishes the selected address under `default`, not `near`.
  // Do not mistake an EVM/Solana default address for a NEAR account.
  const account = config.connectedWallets.near || (intentsAccountType==='near' && config.providers?.near ? config.connectedWallets.default || ctx.walletAddress || null : null);
  const [amount,setAmount] = useState('');
  const [accepted,setAccepted] = useState(false);
  const [message,setMessage] = useState('');
  const [pending,setPending] = useState<PendingJourney|null>(null);
  const status = useOneClickExecutionStatus({depositAddress:pending?.depositAddress ?? ctx.quote?.depositAddress,depositMemo:pending?.depositMemo ?? (ctx.quote && 'depositMemo' in ctx.quote ? ctx.quote.depositMemo : undefined),disabled:!apiKey||preview||!(pending || ctx.quote?.depositAddress)});
  const [session,setSession] = useState(false);
  const historySessionRef = useRef(onHistorySession); historySessionRef.current = onHistorySession;
  const [recoveryBlocked,setRecoveryBlocked] = useState(false);
  const transferLock = useRef(false);
  const walletOpen = useRef(false);
  const identityKey = `${preview}:${account ?? ''}`;
  const identity = useRef({key:identityKey,version:0});
  if(identity.current.key !== identityKey) identity.current={key:identityKey,version:identity.current.version+1};
  useLayoutEffect(()=>()=>{
    // Invalidate old async closures synchronously, including a StrictMode remount.
    identity.current={...identity.current,version:identity.current.version+1};
    activeSigning.current=null;
  },[]);
  const pendingRef=useRef(pending);pendingRef.current=pending;
  const consentGeneration=useRef(0);
  // Explicit revocation is irreversible for an in-flight attempt. The internal
  // checkbox reset after committing that attempt must not revoke its permission.
  const consentRevocation=useRef(0);
  const previousConditions=useRef({quote:ctx.quote,systemId,targetAsset});
  // A background quote refetch (every 15 s) must not discard a signature the wallet is already showing:
  // the journey is bound to the deposit address and amount being signed. Screen-reader users often need
  // longer than one refetch to confirm. Before the wallet opens, a replaced quote still blocks signing.
  if(!walletOpen.current && (previousConditions.current.quote!==ctx.quote || previousConditions.current.systemId!==systemId || previousConditions.current.targetAsset!==targetAsset)){consentGeneration.current++;previousConditions.current={quote:ctx.quote,systemId,targetAsset};}
  const markerKey=(owner:string)=>`nearverse:journal-deleted:${owner}`;
  const pendingKey=(owner:string)=>`nearverse:pending:${owner}`;

  async function removeRecovery(journey:PendingJourney){
    const remove=()=>{const stored=JSON.parse(localStorage.getItem(pendingKey(journey.accountId))||'null');
      if(!stored || stored.eventId !== journey.eventId)return false;
      localStorage.removeItem(pendingKey(journey.accountId));return true;};
    if(!navigator.locks)return remove();
    return navigator.locks.request(`nearverse:transfer:${journey.accountId}`,{ifAvailable:true},lock=>lock?remove():false);
  }
  useEffect(()=>{
    const deleted=(event:Event)=>{
      if(!account)return;
      const owner=event instanceof StorageEvent ? (event.key===markerKey(account)?account:null) : (event as CustomEvent<{accountId:string}>).detail?.accountId;
      if(owner!==account)return;
      identity.current={...identity.current,version:identity.current.version+1};
      const journey=pendingRef.current;if(!journey||journey.accountId!==account)return;
      const ignored={...journey,skipArrival:true};
      // The separate deletion marker fences arrivals without rewriting a financial
      // recovery record that another tab may be completing under its account lock.
      setPending(ignored);setMessage('Journal deleted. Transaction status is retained; this arrival will no longer be added to the journal.');
    };
    window.addEventListener('nearverse:journal-deleted',deleted);window.addEventListener('storage',deleted);
    return()=>{window.removeEventListener('nearverse:journal-deleted',deleted);window.removeEventListener('storage',deleted);};
  },[account]);
  useEffect(()=>{ const ownerIdentity=identity.current;onAccountChange?.(account); setAccepted(false); setAmount(''); setSession(false);setRecoveryBlocked(false);historySessionRef.current?.(false);
    fireEvent('reset',{clearWalletAddress:false,keepSelectedTokens:true});
    loadedRecovery.current=null;
    if(!account || preview){setPending(null);return;}
    void fetch('/api/auth/session',{cache:'no-store'}).then(r=>r.json()).then(s=>{if(identity.current===ownerIdentity && s.accountId===account){setSession(true);historySessionRef.current?.(true);}}).catch(()=>{});
    try { const raw=localStorage.getItem(`nearverse:pending:${account}`);const saved=JSON.parse(raw||'null'); if(saved && (saved.accountId!==account || !['eventId','systemId','depositAddress','originAsset','destinationAsset','amountIn','amountOut','minAmountOut'].every(k=>typeof saved[k]==='string') || !['amountIn','amountOut','minAmountOut'].every(k=>/^[1-9][0-9]{0,77}$/.test(saved[k])))) throw new Error('invalid_recovery');if(saved && (localStorage.getItem(markerKey(account))||'') !== (saved.journalMarker||'')){saved.skipArrival=true;}loadedRecovery.current=saved?{raw:raw!,journey:saved}:null;setPending(saved); } catch {setRecoveryBlocked(true);setMessage('Could not recover the passage. Do not send funds again until you have checked the history.');}
  },[account,preview]);
  useEffect(()=>{
    const check=()=>{
      const recovery=probeRecovery();
      if(!recoveryOwned.current){
        let observed=observeRecovery(mergeRecovery(startupRecovery.current,{entries:activationRecoveryEntries ?? Object.create(null),blocked:activationRecoveryBlocked}),recovery);
        const loaded=loadedRecovery.current;
        // An absent/restoring account is NOT acceptance of saved transactions.
        // Wait for a committed pending object, not merely a scheduled setPending.
        const canOwn=(final:typeof observed)=>{
          const owners=Object.keys(final.entries);
          return final.blocked || !owners.length || (!preview && !!account && owners.length===1 && owners[0]===account && !!loaded && loaded.journey===pending && loaded.raw===final.entries[account]);
        };
        if(canOwn(observed)){
          observed=onRecoveryActivated?.(observed,canOwn) ?? observeRecovery(observed,probeRecovery());
          recoveryOwned.current=canOwn(observed);
        }
        startupRecovery.current=observed;
        if(observed.blocked)setStartupRecoveryChanged(true);
      }
      if(activationBlocked || startupRecovery.current.blocked || recovery.blocked && (recovery.invalid || !recovery.owners.length || recovery.owners.some(owner=>owner!==account))){setRecoveryBlocked(true);setMessage(activationBlocked || startupRecovery.current.blocked?'A saved recovery record disappeared or changed before the wallet module loaded. New swaps are blocked. Check transaction history before reloading.':recovery.message);}
    };
    // Install before the final comparison/handoff, including StrictMode replay.
    window.addEventListener('storage',check);window.addEventListener('focus',check);check();
    return()=>{window.removeEventListener('storage',check);window.removeEventListener('focus',check);};
  },[account,preview,pending,activationBlocked,activationRecoveryEntries,activationRecoveryBlocked,onRecoveryActivated]);
  useEffect(()=>{setAccepted(false);},[ctx.quote,systemId,targetAsset]);
  useEffect(()=>{
    const target = tokens.find(t=>t.isIntent && t.assetId === targetAssetId(targetAsset));
    if(!pending && target && tokenKey(target)!==(ctx.targetToken && tokenKey(ctx.targetToken))) {fireEvent('quoteReset',null);fireEvent('tokenSelect',{variant:'target',token:target});}
  },[tokens,targetAsset,pending]);
  const eligible = tokens.filter(supportedToken);
  const targetTokens = eligible.filter(t=>t.isIntent);
  async function signInHistory(){
    const ownerIdentity=identity.current;
    try {
      if(!account || !config.providers?.near) throw new Error('Connect your NEAR wallet first.');
      const challengeResponse = await fetch('/api/auth/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:account})});
      if(!challengeResponse.ok) throw new Error('The history server did not issue a sign-in challenge.');
      const challenge = await challengeResponse.json();
      if(identity.current!==ownerIdentity)return;
      const signed = await config.providers.near().signMessage({message:challenge.message,recipient:challenge.recipient,nonce:Uint8Array.from(atob(challenge.nonce),c=>c.charCodeAt(0))});
      if(identity.current!==ownerIdentity)return;
      const response = await fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeId:challenge.id,...signed})});
      if(!response.ok) throw new Error('The server did not verify account ownership.');
      if(identity.current!==ownerIdentity)return;setSession(true);historySessionRef.current?.(true);setMessage('Signed in to your personal journal.');
    } catch(error){if(identity.current===ownerIdentity)setMessage(error instanceof Error ? error.message:'Sign-in failed.');}
  }
  function choose(variant:'source'|'target',key:string){
    if(pending) return;
    setAccepted(false);setAmount('');fireEvent('quoteReset',null);fireEvent('tokenSetAmount',{variant:'source',amount:''});
    fireEvent('tokenSelect',{variant,token:eligible.find(t=>tokenKey(t)===key)});
  }
  function inputAmount(value:string){
    setAmount(value);setAccepted(false);
    try { if(!ctx.sourceToken) throw new Error('Select a source asset.');fireEvent('tokenSetAmount',{variant:'source',amount:parseUnits(value,ctx.sourceToken.decimals)});setMessage(''); }
    catch(error){fireEvent('tokenSetAmount',{variant:'source',amount:''});setMessage(error instanceof Error?error.message:'Invalid amount.');}
  }
  async function confirm(){
    if(!account || !navigator.locks){setMessage('Your browser does not support safe cross-tab transaction locking. No signature was requested.');return;}
    const ownerIdentity=identity.current;
    const consentVersion=consentGeneration.current;
    const revocationVersion=consentRevocation.current;
    await navigator.locks.request(`nearverse:transfer:${account}`,{ifAvailable:true},async lock=>{
      if(!lock){setMessage('Another window is already processing a transaction for this account. Do not repeat the transfer.');return;}
      if(identity.current!==ownerIdentity || consentGeneration.current!==consentVersion || consentRevocation.current!==revocationVersion)return;
      await confirmLocked();
    });
  }
  async function confirmLocked(){
    if(transferLock.current) return;
    if(!canConfirm({preview,apiKey,account,quote:ctx.quote,accepted,error:ctx.error,pending:!!pending || recoveryBlocked || activationBlocked}) || !ctx.quote || !ctx.sourceToken || !ctx.targetToken || !account || !systemId) return;
    const quote = ctx.quote;
    if(quote.type !== 'QUOTE_REAL_WITH_AMOUNT' || !quote.depositAddress || quote.dry || !canonicalMinimum) return;
    if(ctx.targetToken.assetId!==targetAssetId(targetAsset)||!supportedToken(ctx.sourceToken))return;
    if(probeRecovery().blocked){setRecoveryBlocked(true);setMessage('A saved or unreadable transaction recovery record blocks new swaps. Reload and recover its outcome before sending again.');return;}
    if(localStorage.getItem(pendingKey(account))!==null){setRecoveryBlocked(true);setMessage('A transaction is already saved in another window. Reload this page to recover it; repeat transfers are blocked.');return;}
    const ownerIdentity=identity.current;
    const source=ctx.sourceToken;
    const consentVersion=consentGeneration.current;
    const revocationVersion=consentRevocation.current;
    const isCurrent=()=>identity.current===ownerIdentity && consentGeneration.current===consentVersion && consentRevocation.current===revocationVersion;
    const journey:PendingJourney={eventId:crypto.randomUUID(),systemId,accountId:account,depositAddress:quote.depositAddress,depositMemo:quote.depositMemo,originAsset:upstreamAssetId(source.assetId),destinationAsset:upstreamAssetId(ctx.targetToken.assetId),amountIn:quote.amountIn,amountOut:quote.amountOut,minAmountOut:canonicalMinimum,journalMarker:localStorage.getItem(markerKey(account))||''};
    try {
      reserveCost(await readReserve(account),source.assetId==='native-near'?BigInt(quote.amountIn):0n);
      const latest=machine.getStore().context.quote;
      if(!isCurrent() || !latest || latest.dry || latest.depositAddress!==quote.depositAddress || !(Date.parse(quote.deadline!)>Date.now()))return;
      const near=tokens.find(t=>t.assetId==='native-near');
      commitBudget(localStorage,account,`${journey.eventId}:route-fees`,routeFeeCost(source,quote.amountIn,quote.amountInUsd,String(near?.price),quote.appFees));
    }catch(error){if(identity.current===ownerIdentity)setMessage(error instanceof Error?error.message:'Reserve not verified.');return;}
    try {localStorage.setItem(`nearverse:pending:${account}`,JSON.stringify(journey));} catch {setMessage('Could not save passage recovery details. No signature was requested.');return;}
    transferLock.current = true;setPending(journey);setAccepted(false);setMessage('Waiting for wallet approval. Sending a deposit does not yet confirm arrival.');
    activeSigning.current={journey,source,deadline:quote.deadline!,current:()=>isCurrent() && JSON.parse(localStorage.getItem(pendingKey(account))||'null')?.eventId===journey.eventId};
    try {
      await makeTransfer();
      if(identity.current !== ownerIdentity)return;
      // An idle/empty SDK result is not proof that no transaction was sent.
      // Keep recovery fenced until the bound service status is terminal.
      setMessage('Check the final status. If the outcome is unknown, do not send funds again.');
    }
    catch {if(identity.current===ownerIdentity)setMessage('The transfer outcome is unknown. The transaction address has been saved; do not repeat the transfer.');}
    finally {transferLock.current = false;activeSigning.current=null;}
  }
  async function verifyArrival(){
    if(!pending || !session || pending.skipArrival || pending.accountId!==account || transferLock.current) return;
    const journey=pending;const ownerIdentity=identity.current;
    try {
      const response=await fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json','X-Nearverse-Account':pending.accountId},body:JSON.stringify({eventId:pending.eventId,type:'arrival',systemId:pending.systemId,proof:{depositAddress:pending.depositAddress,depositMemo:pending.depositMemo,originAsset:pending.originAsset,destinationAsset:pending.destinationAsset,amountIn:pending.amountIn,amountOut:pending.amountOut,minAmountOut:pending.minAmountOut}})});
      if(!response.ok) throw new Error('Arrival has not yet been confirmed by the server. No repeat transfer is needed.');
      const receipt=await response.json();
      if(identity.current!==ownerIdentity)return;
      if(await removeRecovery(journey)){if(identity.current!==ownerIdentity)return;setPending(null);setAccepted(false);setAmount('');fireEvent('reset',{clearWalletAddress:false,keepSelectedTokens:true});onArrival?.(receipt);setMessage('The server has confirmed arrival.');}
      else {setRecoveryBlocked(true);setMessage('The saved transaction changed in another window. Reload the page; repeat transfers are blocked.');}
    } catch(error){if(identity.current===ownerIdentity)setMessage(error instanceof Error?error.message:'Verification is unavailable.');}
  }
  async function acknowledge(){
    if(!pending || transferLock.current || pending.accountId!==account || !mayAcknowledge(status.data?.status,pending,boundRecoveryStatus(status.data,pending)))return;
    const ownerIdentity=identity.current;
    try{if(!await removeRecovery(pending))throw new Error('The saved transaction changed in another window. Reload the page.');
      if(identity.current!==ownerIdentity)return;setPending(null);setAccepted(false);setAmount('');fireEvent('reset',{clearWalletAddress:false,keepSelectedTokens:true});
      setMessage('Transaction recovery closed without recording an arrival. A new swap requires a new quote and separate approval.');
    }catch(error){if(identity.current===ownerIdentity){setRecoveryBlocked(true);setMessage(error instanceof Error?error.message:'Could not update recovery details.');}}
  }
  const canonicalMinimum = getCanonicalMinimum(status.data,ctx.quote,ctx.sourceToken,ctx.targetToken,account,config);
  const allowed = !!navigator.locks && !!canonicalMinimum && canConfirm({preview,apiKey,account,quote:ctx.quote,accepted,error:ctx.error,pending:!!pending || recoveryBlocked || activationBlocked}) && !!systemId;
  const quote = ctx.quote;
  return <div data-sdk-state={ctx.state}>
    <p>NEAR account: {account || 'not connected'}. History: {session?'signed in':'not signed in'}.</p>
    {!preview && <div>{config.onWalletSignin && !account && <button onClick={()=>walletSignIn?.()}>Connect NEAR wallet</button>}{account && <><button onClick={signInHistory}>Sign in to journal: sign a message, no funds transferred</button><button onClick={async()=>{await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});setSession(false);walletSignOut?.('near');}}>Sign out</button></>}</div>}
    <label>Source asset<select disabled={!apiKey||preview||!!pending} value={ctx.sourceToken?tokenKey(ctx.sourceToken):''} onChange={e=>choose('source',e.target.value)}><option value="">Select an asset</option>{eligible.map(t=><option key={tokenKey(t)} value={tokenKey(t)}>{tokenLabel(t)}</option>)}</select></label>
    <label>Destination · Intents balance<select disabled={!apiKey||preview||!!pending} value={ctx.targetToken?tokenKey(ctx.targetToken):''} onChange={e=>choose('target',e.target.value)}><option value="">Select a destination</option>{targetTokens.filter(t=>!targetAsset || t.assetId===targetAssetId(targetAsset)).map(t=><option key={tokenKey(t)} value={tokenKey(t)}>{tokenLabel(t)}</option>)}</select></label>
    <label>Source asset amount<input inputMode="decimal" autoComplete="off" disabled={!apiKey||preview||!!pending} value={amount} onChange={e=>inputAmount(e.target.value)} /></label>
    {ctx.sourceToken && <p>Available balance: {formatUnits(ctx.sourceToken.isIntent?intentBalances[`intent-${ctx.sourceToken.assetId}`]:walletBalance[`${ctx.sourceToken.assetId}-${ctx.sourceToken.blockchain}`],ctx.sourceToken.decimals)}. Before signing, storage costs, gas and the recovery reserve are checked separately using fresh network data. The swap module alone does not guarantee this reserve.</p>}
    {!navigator.locks && !preview && <p>Signing a swap requires a browser with Web Locks to prevent simultaneous transfers from two tabs.</p>}
    <p>Beacon: {systemId || 'not selected'}. Slippage: up to 1%. Liquidity depends on the selected route.</p>
    {ctx.quoteStatus==='pending' && <p role="status">Requesting quote…</p>}
    {(ctx.quoteStatus==='error'||ctx.error) && <p role="alert">Route or amount unavailable: {ctx.error?.code || 'quote error'}. {pending ? 'The transaction outcome is not yet confirmed. Do not send again.' : 'No swap signature is being requested.'}</p>}
    {quote && quote.type !== 'QUOTE_DEPOSIT_ANY_AMOUNT' && ctx.sourceToken && ctx.targetToken && <dl><dt>You pay</dt><dd>{formatUnits(quote.amountIn,ctx.sourceToken.decimals)} {ctx.sourceToken.symbol} · {ctx.sourceToken.assetId}</dd><dt>You receive</dt><dd>{formatUnits(quote.amountOut,ctx.targetToken.decimals)} {ctx.targetToken.symbol} · {ctx.targetToken.assetId} · Intents</dd><dt>Minimum received from the original service quote</dt><dd>{canonicalMinimum ? formatUnits(canonicalMinimum,ctx.targetToken.decimals) : 'Waiting for verification of the original quote. Swap signing is blocked.'}</dd><dt>Fees</dt><dd>No NearVerse fee is added. {JSON.stringify(quote.appFees || [])}. Final amounts include route costs.</dd><dt>Valid until</dt><dd>{quote.deadline || 'Estimate only, not a transfer'}</dd></dl>}
    <label><input type="checkbox" checked={accepted} disabled={!quote || quote.dry || !!pending || preview} onChange={e=>{if(!e.target.checked)consentRevocation.current++;setAccepted(e.target.checked);}}/>I have reviewed the assets, where they are held, the amount and the quote terms.</label>
    <button type="button" disabled={!allowed} onClick={confirm}>Approve terms and request swap signature</button>
    {pending && <div><p role="status">Passage: {status.isError?'UNKNOWN':finalStatus(status.data?.status)}. Transaction address: {pending.depositAddress}. This is not confirmation of arrival.</p><button disabled={!session || pending.skipArrival || pending.accountId!==account || status.data?.status!=='SUCCESS'} onClick={verifyArrival}>Verify arrival with the server</button>{mayAcknowledge(status.data?.status,pending,boundRecoveryStatus(status.data,pending)) && <button type="button" onClick={acknowledge}>Acknowledge outcome and close recovery without arrival</button>}{pending.skipArrival && <p>This journal has been deleted. The transaction is tracked only for safe recovery, without adding the arrival again.</p>}<p>If the outcome is unknown, do not repeat the transfer. Even after cancelling a signature, check the transaction before starting a new swap.</p></div>}
    <p role="status" aria-live="polite">{message}</p>
  </div>;
}
