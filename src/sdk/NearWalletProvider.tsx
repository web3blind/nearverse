import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NearConnector } from '@hot-labs/near-connect';
import type { NearWalletBase } from '@hot-labs/near-connect/build/types/wallet';
import { WidgetConfigProvider } from '@aurora-is-near/intents-swap-widget/config';
import type { WidgetConfig } from '@aurora-is-near/intents-swap-widget/types';

/** The public core NEAR provider contract accepts the connector wallet unchanged.
 * No custom signer, key registration, transaction conversion or chain plugin. */
export function NearWalletProvider({config, children, connectRequest = 0, preview = false}:{config:Partial<WidgetConfig>; children:ReactNode; connectRequest?:number; preview?:boolean}) {
  const connectorRef=useRef<NearConnector|null>(null);
  const [connector,setConnector] = useState<NearConnector>();
  useEffect(()=>{if(!preview && !connector){connectorRef.current ??= new NearConnector({network:'mainnet', autoConnect:false, features:{signMessage:true,signAndSendTransactions:true,signInWithoutAddKey:true},...(typeof localStorage!=='undefined'&&localStorage.getItem('nearverse:debug-wallet')==='1'?{logger:console}:{})});setConnector(connectorRef.current);}},[preview,connector]);
  const [wallet,setWallet] = useState<NearWalletBase>();
  const [account,setAccount] = useState<string>();
  const [error,setError] = useState('');
  const [connecting,setConnecting]=useState(false);
  const [selectorOpen,setSelectorOpen]=useState(false);
  const [wallets,setWallets]=useState<NearWalletBase[]>([]);
  const [manifestReady,setManifestReady]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const connectingRef=useRef(false);
  const handled = useRef(0);
  const generation = useRef(0);
  const acceptConnection=useRef(true);
  useEffect(()=>{
    if(!connector)return;
    let active = true;
    const refresh=()=>{if(active)setWallets(connector.availableWallets);};
    connector.on('selector:walletsChanged',refresh);
    void connector.whenManifestLoaded.then(()=>{if(active){refresh();setManifestReady(true);}});
    const signedIn = ({wallet:next,accounts}:{wallet:NearWalletBase;accounts:Array<{accountId:string}>})=>{
      generation.current++;
      if(active && acceptConnection.current){setWallet(next);setAccount(accounts[0]?.accountId);}
    };
    const signedOut = ()=>{generation.current++;acceptConnection.current=false;if(active){setWallet(undefined);setAccount(undefined);}};
    connector.on('wallet:signIn',signedIn);connector.on('wallet:signOut',signedOut);
    const version = generation.current;
    void connector.getConnectedWallet().then(({wallet:next,accounts})=>{
      if(active && version===generation.current){setWallet(next);setAccount(accounts[0]?.accountId);}
    }).catch((e:unknown)=>{/* No stored connection. Never connect or sign to restore it. */console.info('NearVerse: wallet session not restored:',e instanceof Error?e.message:String(e));});
    return ()=>{active=false;connector.off('selector:walletsChanged',refresh);connector.off('wallet:signIn',signedIn);connector.off('wallet:signOut',signedOut);};
  },[connector]);
  useEffect(()=>{
    const node=dialog.current;if(!node)return;
    if(selectorOpen && !preview){if(!node.open){if(typeof node.showModal==='function')node.showModal();else node.setAttribute('open','');}}
    else if(node.open){if(typeof node.close==='function')node.close();else node.removeAttribute('open');}
  },[selectorOpen,preview]);
  const connect = async()=>{
    if(preview || !connector || connectingRef.current)return;
    setError('');setSelectorOpen(true);
  };
  const chooseWallet = async(id:string)=>{
    if(preview || !connector || connectingRef.current)return;
    setSelectorOpen(false);
    connectingRef.current=true;acceptConnection.current=true;setConnecting(true);setError('');
    try { await connector.connect(id); } catch {setError('Wallet connection was not completed. Try again when you are ready. No swap signature was requested.');}
    finally{connectingRef.current=false;setConnecting(false);}
  };
  useEffect(()=>{
    if(connector && connectRequest>handled.current && !preview){handled.current=connectRequest;void connect();}
  },[connectRequest,preview,connector]);
  const merged = useMemo<Partial<WidgetConfig>>(()=>({...config,
    connectedWallets:preview?{}:{near:account,default:account},
    providers:preview||!wallet?{}:{near:()=>wallet},
    onWalletSignin:connect,
    onWalletSignout:async()=>{generation.current++;acceptConnection.current=false;setWallet(undefined);setAccount(undefined);await connector?.disconnect();},
  }),[config,account,wallet,preview,connector]);
  return <><WidgetConfigProvider config={merged}>{children}</WidgetConfigProvider><dialog ref={dialog} aria-labelledby="near-wallet-selector-heading" aria-modal="true" onCancel={()=>setSelectorOpen(false)} style={{background:'#172731',color:'#e9eee9',border:'1px solid #e5bd81',borderRadius:8,padding:24,maxWidth:'calc(100vw - 32px)'}}><h2 id="near-wallet-selector-heading">Choose a NEAR wallet</h2><p>Connection does not request a swap signature or add an access key.</p>{!manifestReady && <p role="status">Loading supported NEAR wallets…</p>}{manifestReady && !wallets.length && <p role="alert">No compatible NEAR wallets could be loaded. Reload the page to retry.</p>}<ul>{wallets.map(wallet=><li key={wallet.manifest.id}><button type="button" disabled={connecting} onClick={()=>void chooseWallet(wallet.manifest.id)}>{wallet.manifest.name}</button></li>)}</ul><button type="button" onClick={()=>setSelectorOpen(false)}>Cancel wallet connection</button></dialog>{connecting && <p role="status">Choose your NEAR wallet in the wallet selector. No swap signature is requested when connecting.</p>}{error && <div><p role="alert">{error}</p><button type="button" onClick={connect}>Retry NEAR wallet connection</button></div>}</>;
}
