import type { NearWalletBase, NearSignMessageParams, NearSignAndSendTransactionsParams, Token } from '@aurora-is-near/intents-swap-widget/types';
import type { PendingJourney } from './safety';
const ONE=10n**24n;
const MAX_GAS=300_000_000_000_000n;
const integer=(s:unknown):bigint=>{if(typeof s!=='string'||!/^\d{1,78}$/.test(s))throw Error('Invalid amount in transaction validation.');return BigInt(s);};
function exactKeys(value:object,keys:string[]){if(Object.keys(value).some(k=>!keys.includes(k)))throw Error('Unexpected fields in the transaction request. Signing is blocked.');}
export function validateIntent(params:NearSignMessageParams,j:PendingJourney,deadline:string){
 if(params.recipient!=='intents.near'||params.callbackUrl||params.nonce.length!==32)throw Error('The Intents signature request is not bound to this transaction.');
 if(params.message==='Authenticate')return;
 const m=JSON.parse(params.message);exactKeys(m,['signer_id','deadline','intents']);
 if(m.signer_id!==j.accountId||!(Date.parse(m.deadline)>Date.now())||Date.parse(m.deadline)>Date.parse(deadline)||!Array.isArray(m.intents)||m.intents.length!==1)throw Error('The Intents terms do not match this passage.');
 const transfer=m.intents[0];exactKeys(transfer,['intent','receiver_id','tokens']);
 if(transfer.intent!=='transfer'||transfer.receiver_id!==j.depositAddress||!transfer.tokens||Object.keys(transfer.tokens).length!==1||transfer.tokens[j.originAsset]!==j.amountIn)throw Error('The Intents asset, amount or recipient has changed.');
}
export function transactionCost(params:NearSignAndSendTransactionsParams,j:PendingJourney,source:Token):{attached:bigint;gas:bigint}{
 exactKeys(params,['transactions']);
 if(params.transactions.length!==1)throw Error('Unexpected number of transactions in the signing request.');
 const tx=params.transactions[0];exactKeys(tx,['signerId','receiverId','actions']);
 if(tx.signerId && tx.signerId!==j.accountId)throw Error('The transaction account has changed.');
 if(!Array.isArray(tx.actions)||!tx.actions.length)throw Error('Empty transaction.');
 if(source.isIntent){
  const a=tx.actions[0];
  if(tx.receiverId!=='intents.near'||tx.actions.length!==1||a.type!=='FunctionCall'||a.params.methodName!=='add_public_key'||a.params.deposit!=='1'||a.params.gas!=='100000000000000'||!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a.params.args.public_key)))throw Error('Unexpected Intents key registration.');
  exactKeys(a.params.args,['public_key']);
 } else if(source.assetId==='native-near'){
  const a=tx.actions[0];if(tx.receiverId!==j.depositAddress||tx.actions.length!==1||a.type!=='Transfer'||a.params.deposit!==j.amountIn)throw Error('The NEAR transfer does not match the quote.');
 }else{
  if(source.blockchain!=='near'||tx.receiverId!==source.assetId.replace(/^nep141:/,'')||tx.actions.length>2)throw Error('Unsupported token transaction.');
  const last=tx.actions.at(-1)!;
  if(last.type!=='FunctionCall'||last.params.methodName!=='ft_transfer'||last.params.deposit!=='1'||last.params.gas!=='50000000000000'||last.params.args.receiver_id!==j.depositAddress||last.params.args.amount!==j.amountIn)throw Error('The token transfer does not match the quote.');
  exactKeys(last.params.args,['receiver_id','amount']);
  if(tx.actions.length===2){const first=tx.actions[0];if(first.type!=='FunctionCall'||first.params.methodName!=='storage_deposit'||first.params.gas!=='30000000000000'||first.params.args.account_id!==j.depositAddress)throw Error('Unexpected storage deposit.');exactKeys(first.params.args,['account_id']);}
 }
 let attached=0n;for(const action of tx.actions){exactKeys(action,['type','params']);exactKeys(action.params,action.type==='Transfer'?['deposit']:['methodName','args','gas','deposit']);attached+=integer(action.params.deposit);}
 // Covers transaction/action overhead, SDK's at most 100 Tgas, and a full
 // 300 Tgas recovery transaction. Current RPC gas price is doubled below.
 return {attached,gas:MAX_GAS};
}
export type ReserveState={amount:string;locked:string;storageUsage:number;storagePerByte:string;gasPrice:string};
export function assertAccountKey(keys:unknown,key:unknown){
 if(typeof key!=='string'||!Array.isArray(keys)||!keys.some(entry=>entry?.public_key===key&&entry?.access_key?.permission==='FullAccess'))throw Error('The Intents key has not been verified as a full-access key for this NEAR account.');
}
export function reserveCost(state:ReserveState,attached:bigint,gas=MAX_GAS){
 const storage=BigInt(state.storageUsage)*integer(state.storagePerByte);
 const locked=integer(state.locked);const stake=storage>locked?storage-locked:0n;
 const gasReserve=(gas+MAX_GAS)*integer(state.gasPrice)*2n;
 if(integer(state.amount)<stake+attached+gasReserve)throw Error('Insufficient NEAR for the transfer, storage costs, gas and recovery reserve.');
 return gasReserve;
}
export async function readReserve(account:string):Promise<ReserveState>{
 async function rpc(method:string,params:unknown){
  const r=await fetch('https://free.rpc.fastnear.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'nearverse-reserve',method,params}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('The reserve verification endpoint is unavailable. No signature was requested.');
  const d=await r.json();if(d.error||!d.result)throw Error('The network did not verify the reserve.');return d.result;
 }
 const [accountState,gas,protocol]=await Promise.all([rpc('query',{request_type:'view_account',account_id:account,finality:'final'}),rpc('gas_price',[null]),rpc('EXPERIMENTAL_protocol_config',{finality:'final'})]);
 if(!Number.isSafeInteger(accountState.storage_usage)||accountState.storage_usage<0)throw Error('Storage reserve is unknown.');
 return {amount:accountState.amount,locked:accountState.locked,storageUsage:accountState.storage_usage,gasPrice:gas.gas_price,storagePerByte:protocol.runtime_config.storage_amount_per_byte};
}
function decimal(value:string):bigint{if(!/^\d+(\.\d{1,18})?$/.test(value))throw Error('Route cost is unknown for the shared budget.');const [w,f='']=value.split('.');return BigInt(w+f.padEnd(18,'0'));}
export function routeFeeCost(source:Token,amountIn:string,amountInUsd:string,nearPrice:string,fees:readonly {recipient:string;fee:number}[]=[]){
 if(!Array.isArray(fees)||fees.some(f=>!f||typeof f.recipient!=='string'||!f.recipient||!Number.isInteger(f.fee)||f.fee<0||f.fee>10000))throw Error('Route fee is unknown.');
 const bps=fees.reduce((sum,f)=>sum+BigInt(f.fee),0n);if(bps>10000n)throw Error('Invalid total route fee.');
 if(bps===0n)return 0n;
 if(source.assetId==='native-near'||source.assetId==='nep141:wrap.near')return (integer(amountIn)*bps+9999n)/10000n;
 const price=decimal(nearPrice);if(price<=0n)throw Error('The NEAR price is unknown for the fee budget.');
 const denominator=price*100n*10000n;
 return (decimal(amountInUsd)*ONE*110n*bps+denominator-1n)/denominator;
}
type Ledger={version:1;account:string;spent:string;operations:Record<string,string>};
export function commitBudget(storage:Pick<Storage,'getItem'|'setItem'>,account:string,id:string,cost:bigint){
 if(!account)throw Error('A NEAR account is required.');
 const key=`nearverse:qa-budget:${account}`;const raw=storage.getItem(key);
 const ledger:Ledger=raw?JSON.parse(raw):{version:1,account,spent:'0',operations:{}};
 if(ledger.version!==1||ledger.account!==account||!ledger.operations||integer(ledger.spent)!==Object.values(ledger.operations).reduce((s,x)=>s+integer(x),0n))throw Error('The shared budget ledger is corrupted.');
 if(ledger.operations[id]!==undefined)throw Error('This signature is already accounted for. Resubmission is prohibited.');
 const next=integer(ledger.spent)+cost;if(cost<0n)throw Error('Invalid operation cost.');
 ledger.operations[id]=cost.toString();ledger.spent=next.toString();storage.setItem(key,JSON.stringify(ledger));
}
export function guardedNearWallet(provider:NearWalletBase,j:PendingJourney,source:Token,deadline:string,isCurrent:()=>boolean,onWallet:(open:boolean)=>void=()=>{}):NearWalletBase {
 const inWallet=async<T>(work:()=>Promise<T>)=>{onWallet(true);try{return await work();}finally{onWallet(false);}};
 let authenticatedKey:string|undefined;
 const ensure=()=>{if(!isCurrent()||!(Date.parse(deadline)>Date.now()))throw Error('Transaction terms have changed or expired. Signing is blocked.');};
 return {
  async signMessage(params){ensure();if(!source.isIntent)throw Error('Intents signing is prohibited for an external deposit.');validateIntent(params,j,deadline);reserveCost(await readReserve(j.accountId),0n);ensure();const signed=await inWallet(()=>provider.signMessage(params));ensure();if(signed.accountId!==j.accountId)throw Error('The wallet signed with a different account.');if(params.message==='Authenticate')authenticatedKey=signed.publicKey;return signed;},
  async signAndSendTransactions(params){ensure();const cost=transactionCost(params,j,source);const first=params.transactions[0].actions[0];if(source.isIntent&&first.type==='FunctionCall'&&authenticatedKey&&first.params.args.public_key!==authenticatedKey)throw Error('A different public key is being registered.');
   if(source.isIntent && first.type==='FunctionCall'){
    // The SDK may restore its public-key cache without calling Authenticate.
    // Never let that mutable cache register somebody else's Intents key.
    const response=await fetch('https://free.rpc.fastnear.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'account-key',method:'query',params:{request_type:'view_access_key_list',account_id:j.accountId,finality:'final'}}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('The account key has not been verified.');const data=await response.json();assertAccountKey(data.result?.keys,first.params.args.public_key);ensure();
   }
   const reserve=await readReserve(j.accountId);const gas=reserveCost(reserve,cost.attached,cost.gas);ensure();
   if(!source.isIntent && source.assetId!=='native-near' && params.transactions[0].actions.length===2){
    const response=await fetch('https://free.rpc.fastnear.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'storage',method:'query',params:{request_type:'call_function',account_id:source.assetId.replace(/^nep141:/,''),method_name:'storage_balance_bounds',args_base64:btoa('{}'),finality:'final'}}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(data.error||!data.result?.result)throw Error('The storage deposit has not been verified.');const bounds=JSON.parse(new TextDecoder().decode(Uint8Array.from(data.result.result)));if(first.params.deposit!==bounds.min)throw Error('The storage deposit differs from the contract minimum.');
   }
   ensure();commitBudget(localStorage,j.accountId,`${j.eventId}:transaction`,(source.assetId==='native-near'?0n:cost.attached)+gas);return provider.signAndSendTransactions(params);
  },
 };
}
