import {describe,expect,it} from 'vitest';
import {canonicalMinimum,upstreamAssetId} from '../src/sdk/safety';
import {QuoteRequest} from '@defuse-protocol/one-click-sdk-typescript';
const policy={slippageTolerance:100,appFees:[]};
const quote={dry:false,depositAddress:'deposit.near',amountIn:'100',amountOut:'200',deadline:'2099-01-01T00:00:00Z'};
const target={assetId:'nep141:nbtc.bridge.near',isIntent:true};
function status(source:{assetId:string;isIntent:boolean}){
 const quoteRequest:QuoteRequest={dry:false,slippageTolerance:100,appFees:[],deadline:'2099-01-01T01:00:00Z',amount:quote.amountIn,swapType:QuoteRequest.swapType.EXACT_INPUT,depositType:source.isIntent?QuoteRequest.depositType.INTENTS:QuoteRequest.depositType.ORIGIN_CHAIN,refundType:source.isIntent?QuoteRequest.refundType.INTENTS:QuoteRequest.refundType.ORIGIN_CHAIN,recipientType:QuoteRequest.recipientType.INTENTS,recipient:'alice.near',refundTo:'alice.near',originAsset:upstreamAssetId(source.assetId),destinationAsset:target.assetId};
 return {status:'PENDING_DEPOSIT',quoteResponse:{quote:{...quote,minAmountOut:'190'},quoteRequest}};
}
describe('authoritative quote binding before any wallet signature',()=>{
 it.each([{assetId:'native-near',isIntent:false},{assetId:'nep141:usdt.tether-token.near',isIntent:false},{assetId:'nep141:wrap.near',isIntent:true}])('accepts exact source identity/custody %j',source=>expect(canonicalMinimum(status(source),quote,source,target,'alice.near',policy)).toBe('190'));
 it('uses the published SDK synthetic ID exactly; never repairs a malformed source token',()=>{expect(upstreamAssetId('native-near')).toBe('nep141:wrap.near');expect(upstreamAssetId('native:near')).toBe('native:near');});
 it('refuses completed, deposited, failed, refunded or unknown operation addresses before signing again',()=>{const source={assetId:'native-near',isIntent:false};for(const value of ['SUCCESS','KNOWN_DEPOSIT_TX','PROCESSING','FAILED','REFUNDED','UNKNOWN'])expect(canonicalMinimum({...status(source),status:value},quote,source,target,'alice.near',policy)).toBeUndefined();});
 it('rejects identity, custody, amount, memo, dry and minimum mismatches',()=>{
  const source={assetId:'native-near',isIntent:false};
  for(const mutation of [
    (s:ReturnType<typeof status>)=>{s.quoteResponse.quoteRequest.recipient='bob.near';},
    (s:ReturnType<typeof status>)=>{s.quoteResponse.quoteRequest.refundTo='bob.near';},
    (s:ReturnType<typeof status>)=>{s.quoteResponse.quoteRequest.depositType=QuoteRequest.depositType.INTENTS;},
    (s:ReturnType<typeof status>)=>{s.quoteResponse.quoteRequest.refundType=QuoteRequest.refundType.INTENTS;},
    (s:ReturnType<typeof status>)=>{s.quoteResponse.quoteRequest.dry=true;},
    (s:ReturnType<typeof status>)=>{s.quoteResponse.quote.amountIn='99';},
    (s:ReturnType<typeof status>)=>{s.quoteResponse.quote.minAmountOut='201';},
  ]){const value=status(source);mutation(value);expect(canonicalMinimum(value,quote,source,target,'alice.near',policy)).toBeUndefined();}
  expect(canonicalMinimum(status(source),{...quote,depositMemo:'different'},source,target,'alice.near',policy)).toBeUndefined();
 });
 it.each([undefined,'','not-a-date','2020-01-01T00:00:00Z','2099-01-02T00:00:00Z'])('rejects absent, invalid, expired or mismatched canonical deadline: %s',deadline=>{
  const source={assetId:'native-near',isIntent:false};const value=status(source);
  expect(canonicalMinimum({...value,quoteResponse:{...value.quoteResponse,quote:{...value.quoteResponse.quote,deadline}}},quote,source,target,'alice.near',policy)).toBeUndefined();
 });
 it('rejects expiry even when both canonical and displayed deadlines match',()=>{
  const source={assetId:'native-near',isIntent:false};const value=status(source);value.quoteResponse.quote.deadline='2020-01-01T00:00:00Z';
  expect(canonicalMinimum(value,{...quote,deadline:value.quoteResponse.quote.deadline},source,target,'alice.near',policy)).toBeUndefined();
 });
 it.each([undefined,0,99,101,10000,'100',NaN])('requires canonical slippage exactly 100 basis points: %s',slippageTolerance=>{
  const source={assetId:'native-near',isIntent:false};const value=status(source);
  expect(canonicalMinimum({...value,quoteResponse:{...value.quoteResponse,quoteRequest:{...value.quoteResponse.quoteRequest,slippageTolerance}}},quote,source,target,'alice.near',policy)).toBeUndefined();
 });
 it('rejects missing/custom configured fees or altered configured slippage',()=>{
  const source={assetId:'native-near',isIntent:false};
  for(const invalidPolicy of [{slippageTolerance:100},{slippageTolerance:101,appFees:[]},{slippageTolerance:100,appFees:[{recipient:'nearverse.near',fee:10}]}])expect(canonicalMinimum(status(source),quote,source,target,'alice.near',invalidPolicy)).toBeUndefined();
 });
 it('allows upstream applied/split service fees only when bound to displayed fees, with no custom NearVerse fees',()=>{
  const source={assetId:'native-near',isIntent:false};const value=status(source);
  const appFees=[{recipient:'service.near',fee:10},{recipient:'route.near',fee:5}];value.quoteResponse.quoteRequest.appFees=appFees;
  expect(canonicalMinimum(value,{...quote,appFees},source,target,'alice.near',policy)).toBe('190');
  for(const displayed of [undefined,[],[{recipient:'other.near',fee:15}],[{recipient:'service.near',fee:11},appFees[1]]])expect(canonicalMinimum(value,{...quote,appFees:displayed},source,target,'alice.near',policy)).toBeUndefined();
  expect(canonicalMinimum(status(source),{...quote,appFees},source,target,'alice.near',policy)).toBeUndefined();
 });
 it.each([null,{},[{recipient:'service.near',fee:-1}],[{recipient:'',fee:10}],[{recipient:'service.near',fee:NaN}],[{recipient:'service.near',fee:0.5}]])('refuses malformed applied fees even when both views agree: %j',appFees=>{
  const source={assetId:'native-near',isIntent:false};const value=status(source);
  const data={...value,quoteResponse:{...value.quoteResponse,quoteRequest:{...value.quoteResponse.quoteRequest,appFees}}};
  expect(canonicalMinimum(data,{...quote,appFees:appFees as never},source,target,'alice.near',policy)).toBeUndefined();
 });
});
