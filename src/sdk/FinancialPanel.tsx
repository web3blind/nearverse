import { Component, Suspense, lazy, useMemo, type ReactNode } from 'react';
const NearWalletProvider=lazy(async()=>({default:(await import('./NearWalletProvider')).NearWalletProvider}));
import type { WidgetConfig } from '@aurora-is-near/intents-swap-widget/types';
import { HeadlessConverter } from './HeadlessConverter';
import { assetIds } from '../assets';
import type {RecoveryObservation} from './recoveryProbe';
import '@aurora-is-near/intents-swap-widget/styles.css';
export interface FinancialPanelProps { onRecoveryActivated?:(accepted:RecoveryObservation,canOwn:(final:RecoveryObservation)=>boolean)=>RecoveryObservation; activationRecoveryEntries?:Record<string,string>; activationRecoveryBlocked?:boolean; connectRequest?:number; preview:boolean; targetAsset?:string; systemId?:string; onAccountChange?:(account:string|null)=>void; onArrival?:(journey:unknown)=>void; onHistorySession?:(active:boolean)=>void; onShipSigner?:(signer:ShipSigner|undefined)=>void }
/** Signs only a social.near `set` of the connected account's own NearVerse ship. */
export type ShipSigner = (params:{transactions:{signerId:string;receiverId:string;actions:{type:'FunctionCall';params:{methodName:string;args:{data:Record<string,unknown>};gas:string;deposit:string}}[]}[]})=>Promise<unknown>;
class SDKBoundary extends Component<{children:ReactNode},{error:boolean}> {
  state = {error:false};
  static getDerivedStateFromError(){return {error:true};}
  render(){return this.state.error ? <div><p role="alert">The swap module is unavailable. If a transaction has already started, its outcome is unknown: do not repeat the transfer. Reload the page to recover its status.</p><button type="button" onClick={()=>window.location.reload()}>Reload page to recover the wallet module</button></div> : this.props.children;}
}
export function FinancialPanel(props:FinancialPanelProps) {
  const apiKey = import.meta.env.VITE_AURORA_API_KEY?.trim() || undefined;
  const config = useMemo<Partial<WidgetConfig>>(() => ({
    apiKey, environment:'production', connectedWallets:{}, enableAccountAbstraction:true,
    confidentialMode:'public', slippageTolerance:100, allowSwapWithExternalWallet:false,
    enableAutoTokensSwitching:false, showTransactionHistory:false, appFees:[],
    filterTokens:(token)=>token.assetId==='native-near' || Object.values(assetIds).some(id=>id===token.assetId),
  }),[apiKey]);
  const inner = <HeadlessConverter {...props} apiKey={apiKey}/>;
  return <section aria-labelledby="financial-heading" className="financial-panel">
    <h2 id="financial-heading">NEAR Intents converter</h2>
    <p>A passage is a fictional representation of a real swap. Amounts, fees and signing are shown separately. BTC, ETH and SOL in your Intents balance are not withdrawals to the Bitcoin, Ethereum or Solana networks.</p>
    {!apiKey && <p role="status">The public Aurora integration key is not configured. Live quotes and swaps are blocked. This is not a test quote.</p>}
    {props.preview && <p>Preview: wallets and real swaps are disabled.</p>}
    <SDKBoundary><Suspense fallback={<p role="status">Loading NEAR wallet module. The wallet selector will open automatically.</p>}><NearWalletProvider config={config} preview={props.preview} connectRequest={props.connectRequest}>{inner}</NearWalletProvider></Suspense></SDKBoundary>
  </section>;
}
