import {describe,expect,it,vi} from 'vitest';
import type {Token,NearSignMessageParams,NearSignAndSendTransactionsParams} from '@aurora-is-near/intents-swap-widget/types';
import {assertAccountKey,commitBudget,routeFeeCost,reserveCost,transactionCost,validateIntent,guardedNearWallet} from '../src/sdk/signing';
import {assetIds,supportedToken,targetAssetId} from '../src/assets';
import type {PendingJourney} from '../src/sdk/safety';
const j:PendingJourney={eventId:'operation',accountId:'alice.near',systemId:'btc-basalt',depositAddress:'deposit.near',originAsset:assetIds.NEAR,destinationAsset:assetIds.BTC,amountIn:'100000000000000000000000',amountOut:'100',minAmountOut:'99'};
const source:Token={assetId:'native-near',decimals:24,blockchain:'near',symbol:'NEAR',price:3,icon:'',name:'NEAR',chainName:'Near',isIntent:false};
const deadline='2099-01-01T00:00:00Z';
const message=()=>({signer_id:j.accountId,deadline:'2098-01-01T00:00:00Z',intents:[{intent:'transfer',receiver_id:j.depositAddress,tokens:{[j.originAsset]:j.amountIn}}]});
const intent=(m=message()):NearSignMessageParams=>({message:JSON.stringify(m),recipient:'intents.near',nonce:new Uint8Array(32)});
const nativeTx=():NearSignAndSendTransactionsParams=>({transactions:[{signerId:j.accountId,receiverId:j.depositAddress,actions:[{type:'Transfer',params:{deposit:j.amountIn}}]}]});
const state={amount:'1000000000000000000000000',locked:'0',storageUsage:2000,storagePerByte:'10000000000000000000',gasPrice:'100000000'};
function storage(){const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};}
describe('exact supported energy identities',()=>{
 it('maps only exact confirmed assets, never same-symbol substitutes',()=>{expect(targetAssetId('USDC')).toBe(assetIds.USDC);expect(targetAssetId('SOL')).toBe(assetIds.SOL);expect(targetAssetId('DOGE')).toBeUndefined();expect(supportedToken({...source,assetId:'nep141:fake.near',isIntent:true})).toBe(false);for(const assetId of Object.values(assetIds))expect(supportedToken({...source,assetId,isIntent:true})).toBe(true);});
});
describe('guard the exact SDK signing boundary',()=>{
 it('does not trust the mutable SDK public-key cache for key registration',()=>{const keys=[{public_key:'ed25519:owned',access_key:{permission:'FullAccess'}},{public_key:'ed25519:limited',access_key:{permission:{FunctionCall:{}}}}];expect(()=>assertAccountKey(keys,'ed25519:owned')).not.toThrow();expect(()=>assertAccountKey(keys,'ed25519:foreign')).toThrow();expect(()=>assertAccountKey(keys,'ed25519:limited')).toThrow();expect(()=>assertAccountKey(undefined,'ed25519:owned')).toThrow();});
 it('accepts sole operation-bound transfer intent and exact native SDK transaction',()=>{expect(()=>validateIntent(intent(),j,deadline)).not.toThrow();expect(transactionCost(nativeTx(),j,source).attached.toString()).toBe(j.amountIn);});
 it('rejects wrong intent owner, asset, amount, receiver, action, extra action, deadline and fields before signing',()=>{
  const mutations=[(m:ReturnType<typeof message>)=>{m.signer_id='other.near';},(m:ReturnType<typeof message>)=>{m.intents[0].tokens={[assetIds.ETH]:j.amountIn};},(m:ReturnType<typeof message>)=>{m.intents[0].tokens[j.originAsset]='1';},(m:ReturnType<typeof message>)=>{m.intents[0].receiver_id='other.near';},(m:ReturnType<typeof message>)=>{m.intents[0].intent='withdraw';},(m:ReturnType<typeof message>)=>{m.intents.push(m.intents[0]);},(m:ReturnType<typeof message>)=>{m.deadline='2000-01-01';},(m:ReturnType<typeof message>)=>{m.deadline='2100-01-01';}];
  for(const mutate of mutations){const m=message();mutate(m);expect(()=>validateIntent(intent(m),j,deadline)).toThrow();}
  expect(()=>validateIntent({...intent(),message:JSON.stringify({...message(),extra:true})},j,deadline)).toThrow();
  expect(()=>validateIntent({...intent(),callbackUrl:'https://other.test/'},j,deadline)).toThrow();expect(()=>validateIntent({...intent(),recipient:'other.near'},j,deadline)).toThrow();
 });
 it('blocks changed transaction signer/receiver/principal and unapproved actions',()=>{for(const change of [(t:NearSignAndSendTransactionsParams)=>{t.transactions[0].signerId='other.near';},(t:NearSignAndSendTransactionsParams)=>{t.transactions[0].receiverId='other.near';},(t:NearSignAndSendTransactionsParams)=>{t.transactions[0].actions[0].params.deposit='1';}]){const t=nativeTx();change(t);expect(()=>transactionCost(t,j,source)).toThrow();}});
 it('fails before wallet invocation on mismatched intent or stale generation',async()=>{const provider={signMessage:vi.fn(),signAndSendTransactions:vi.fn()};const w=guardedNearWallet(provider,j,{...source,isIntent:true},deadline,()=>true);await expect(w.signMessage({...intent(),recipient:'other.near'})).rejects.toThrow();expect(provider.signMessage).not.toHaveBeenCalled();await expect(guardedNearWallet(provider,j,source,deadline,()=>false).signAndSendTransactions(nativeTx())).rejects.toThrow();expect(provider.signAndSendTransactions).not.toHaveBeenCalled();});
});
describe('wallet response remains bound to the current operation',()=>{
 it.each(['revoked','expired','current'] as const)('checks the operation after an awaited wallet signature: %s',async(mode)=>{
  type Signed=Awaited<ReturnType<ReturnType<typeof guardedNearWallet>['signMessage']>>;
  let release!:(value:Signed)=>void;let requested!:()=>void;
  const signed=new Promise<Signed>(resolve=>{release=resolve;});
  const prompt=new Promise<void>(resolve=>{requested=resolve;});
  let current=true;
  const fixture={accountId:j.accountId,publicKey:'fixture-public-key',signature:'controlled-test-fixture'} as Signed;
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
   const {method}=JSON.parse(String(init.body));
   const result=method==='gas_price'?{gas_price:'1'}:method==='EXPERIMENTAL_protocol_config'?{runtime_config:{storage_amount_per_byte:'0'}}:{amount:state.amount,locked:'0',storage_usage:0};
   return {ok:true,json:async()=>({result})};
  }));
  try{
   const provider={signMessage:vi.fn(async()=>{requested();return signed;}),signAndSendTransactions:vi.fn()};
   const operation=guardedNearWallet(provider,j,{...source,isIntent:true},deadline,()=>current).signMessage(intent());
   await prompt;
   if(mode==='revoked')current=false;
   if(mode==='expired')vi.spyOn(Date,'now').mockReturnValue(Date.parse(deadline)+1);
   release(fixture);
   if(mode==='current')await expect(operation).resolves.toBe(fixture);
   else await expect(operation).rejects.toThrow('Transaction terms have changed or expired');
   expect(provider.signMessage).toHaveBeenCalledTimes(1);
   expect(provider.signAndSendTransactions).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();vi.restoreAllMocks();}
 });
});
describe('fresh native reserve and a single durable original budget',()=>{
 it('does not allow full balance to bypass storage/gas/recovery reserve',()=>{expect(()=>reserveCost(state,BigInt(state.amount))).toThrow();expect(reserveCost(state,BigInt(j.amountIn))).toBeGreaterThan(0n);});
 it('rejects token/Intents operations without native gas even with zero principal attached',()=>{expect(()=>reserveCost({...state,amount:'20000000000000000000000'},0n)).toThrow();});
 it('does not charge turnover when the route has no applied fees',()=>{expect(routeFeeCost(source,j.amountIn,'0.3','3')).toBe(0n);expect(routeFeeCost({...source,isIntent:true,assetId:assetIds.NEAR},j.amountIn,'0.3','3')).toBe(0n);});
 it('rejects repeated signatures without capping amounts or restricting accounts',()=>{const s=storage();commitBudget(s,j.accountId,'first',700000000000000000000000n);expect(()=>commitBudget(s,j.accountId,'first',1n)).toThrow();commitBudget(s,j.accountId,'second-large',5000000000000000000000000n);commitBudget(s,'other.near','x',1n);expect(()=>commitBudget(s,'other.near','x',1n)).toThrow();expect(()=>commitBudget(s,j.accountId,'negative',-1n)).toThrow();});
 it('fails closed on a corrupted budget ledger',()=>{const s=storage();s.setItem(`nearverse:qa-budget:${j.accountId}`,'{}');expect(()=>commitBudget(s,j.accountId,'x',1n)).toThrow();});
});
