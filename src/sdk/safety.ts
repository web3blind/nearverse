export function parseUnits(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30 || value.length > 100 || !/^\d+(\.\d+)?$/.test(value)) throw new Error('Enter a positive number using a period as the decimal separator.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Maximum decimal places: ${decimals}.`);
  const result = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (result <= 0n) throw new Error('The amount must be greater than zero.');
  return result.toString();
}
export function formatUnits(value: string | 0 | undefined, decimals: number): string {
  if (value === undefined) return 'not loaded';
  const padded = String(value).padStart(decimals + 1, '0');
  if (!decimals) return padded;
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(/\.?0+$/, '') || '0';
}
export type PendingJourney = { eventId:string; systemId:string; accountId:string; depositAddress:string; depositMemo?:string; originAsset:string; destinationAsset:string; amountIn:string; amountOut:string; minAmountOut:string; signatureRejected?:boolean; skipArrival?:boolean; journalMarker?:string };
export type JourneyStatus = 'PENDING' | 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'UNKNOWN';
export function finalStatus(status: unknown): JourneyStatus {
  return status === 'SUCCESS' || status === 'REFUNDED' || status === 'FAILED' ? status : typeof status === 'string' && ['PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','PROCESSING'].includes(status) ? 'PENDING' : 'UNKNOWN';
}
export function boundRecoveryStatus(input:unknown,journey:PendingJourney): boolean {
  const value=input as {quoteResponse?:{quote?:{depositAddress?:string;depositMemo?:string;amountIn?:string;amountOut?:string;minAmountOut?:string};quoteRequest?:{originAsset?:string;destinationAsset?:string;recipient?:string;refundTo?:string;recipientType?:string}}}|null;
  const quote=value?.quoteResponse?.quote;const request=value?.quoteResponse?.quoteRequest;
  return !!quote && !!request && quote.depositAddress===journey.depositAddress && (quote.depositMemo||'')===(journey.depositMemo||'') && quote.amountIn===journey.amountIn && quote.amountOut===journey.amountOut && quote.minAmountOut===journey.minAmountOut && request.originAsset===journey.originAsset && request.destinationAsset===journey.destinationAsset && request.recipient===journey.accountId && request.refundTo===journey.accountId && request.recipientType==='INTENTS';
}
export function mayAcknowledge(status:unknown,journey:PendingJourney,bound:boolean): boolean {
  return bound && (status==='REFUNDED'||status==='FAILED'||(status==='SUCCESS'&&journey.skipArrival===true));
}
export const upstreamAssetId=(asset:string)=>asset==='native-near'?'nep141:wrap.near':asset;
type AppFee={recipient:string;fee:number};
type QuoteView={dry:boolean;depositAddress?:string;depositMemo?:string;amountIn?:string;amountOut?:string;deadline?:string;appFees?:readonly AppFee[]};
type TokenView={assetId:string;isIntent:boolean};
type QuotePolicy={slippageTolerance?:number;appFees?:readonly AppFee[]};
function appliedFees(input:unknown):readonly AppFee[]|undefined {
  // The pinned SDK makes applied fees optional; omitted means no applied fees.
  if(input===undefined)return [];
  if(!Array.isArray(input) || !input.every(fee=>fee && typeof fee.recipient==='string' && fee.recipient.length>0 && Number.isInteger(fee.fee) && fee.fee>=0 && fee.fee<=10000))return;
  return input;
}
export function canonicalMinimum(input:unknown,quote:QuoteView|undefined,source:TokenView|undefined,target:TokenView|undefined,owner:string|null,policy:QuotePolicy):string|undefined {
  const value=input as {status?:string;quoteResponse?:{quote?:QuoteView&{minAmountOut?:string};quoteRequest?:{dry?:boolean;depositType?:string;refundType?:string;recipientType?:string;recipient?:string;refundTo?:string;originAsset?:string;destinationAsset?:string;slippageTolerance?:number;appFees?:readonly AppFee[]}}}|undefined;
  const original=value?.quoteResponse?.quote;const request=value?.quoteResponse?.quoteRequest;
  const kind=source?.isIntent?'INTENTS':'ORIGIN_CHAIN';
  if(!quote || quote.dry || !source || !target?.isIntent || !owner || !original || !request || value?.status!=='PENDING_DEPOSIT' || request.dry!==false || request.depositType!==kind || request.refundType!==kind || request.recipientType!=='INTENTS' || request.recipient!==owner || request.refundTo!==owner)return;
  if(!quote.depositAddress || original.depositAddress!==quote.depositAddress || (original.depositMemo||'')!==(quote.depositMemo||'') || original.amountIn!==quote.amountIn || original.amountOut!==quote.amountOut || request.originAsset!==upstreamAssetId(source.assetId) || request.destinationAsset!==upstreamAssetId(target.assetId))return;
  if(!original.deadline || original.deadline!==quote.deadline || !(Date.parse(original.deadline)>Date.now()))return;
  if(policy.slippageTolerance!==100 || request.slippageTolerance!==100 || !Array.isArray(policy.appFees) || policy.appFees.length!==0)return;
  // appFees: [] is NearVerse's *configured* fee policy, not a promise that the
  // upstream service charges nothing. The SDK carries server-resolved/split base
  // fees on Quote.appFees; bind those displayed fees to the authoritative response.
  const canonicalFees=appliedFees(request.appFees);const displayedFees=appliedFees(quote.appFees);
  if(!canonicalFees || !displayedFees || canonicalFees.length!==displayedFees.length || canonicalFees.some((fee,index)=>fee.recipient!==displayedFees[index].recipient || fee.fee!==displayedFees[index].fee))return;
  if(!/^[1-9][0-9]{0,77}$/.test(original.minAmountOut||'') || !/^[1-9][0-9]{0,77}$/.test(original.amountOut||'') || BigInt(original.minAmountOut!)>BigInt(original.amountOut!))return;
  return original.minAmountOut;
}
export function canConfirm(input:{preview:boolean; apiKey?:string; account?:string|null; quote?:{dry:boolean; deadline?:string}; accepted:boolean; error?:unknown; pending:boolean}): boolean {
  return !input.preview && !!input.apiKey && !!input.account && !!input.quote && !input.quote.dry && !!input.quote.deadline && Date.parse(input.quote.deadline) > Date.now() && input.accepted && !input.error && !input.pending;
}
