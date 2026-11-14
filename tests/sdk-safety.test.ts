import { describe, expect, it } from 'vitest';
import {canConfirm, finalStatus, formatUnits, parseUnits, mayAcknowledge, type PendingJourney} from '../src/sdk/safety';
const recovery:PendingJourney={eventId:'event',systemId:'btc',accountId:'alice.near',depositAddress:'deposit.near',originAsset:'nep141:wrap.near',destinationAsset:'nep141:nbtc.bridge.near',amountIn:'100',amountOut:'200',minAmountOut:'190'};
describe('recovery acknowledgement fences',()=>{
 it.each(['PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','PROCESSING','UNKNOWN',undefined,null])('never treats %s or a legacy signing-rejection flag as proof of no deposit',status=>{
  for(const signatureRejected of [undefined,false,true])for(const skipArrival of [undefined,true])expect(mayAcknowledge(status,{...recovery,signatureRejected,skipArrival},true)).toBe(false);
 });
 it('requires a bound terminal response; SUCCESS also requires journal deletion',()=>{
  for(const status of ['FAILED','REFUNDED']){expect(mayAcknowledge(status,recovery,true)).toBe(true);expect(mayAcknowledge(status,recovery,false)).toBe(false);}
  expect(mayAcknowledge('SUCCESS',recovery,true)).toBe(false);
  expect(mayAcknowledge('SUCCESS',{...recovery,skipArrival:true},true)).toBe(true);
  expect(mayAcknowledge('SUCCESS',{...recovery,skipArrival:true},false)).toBe(false);
 });
});
describe('financial safety (no wallet actions)',()=>{
 it('uses exact integer units for 24 decimals',()=>{expect(parseUnits('1.000000000000000000000001',24)).toBe('1000000000000000000000001');expect(formatUnits('1000000000000000000000001',24)).toBe('1.000000000000000000000001');});
 it.each(['0','-1','1e3','NaN','0x10','.1','1.0000001'])('rejects malformed or excessive amounts: %s',value=>expect(()=>parseUnits(value,6)).toThrow());
 it('separates deposit acceptance from final arrival',()=>{expect(finalStatus('KNOWN_DEPOSIT_TX')).toBe('PENDING');expect(finalStatus('transfer_success')).toBe('UNKNOWN');expect(finalStatus('SUCCESS')).toBe('SUCCESS');expect(finalStatus('REFUNDED')).toBe('REFUNDED');expect(finalStatus('FAILED')).toBe('FAILED');});
 it('fails closed for preview, absent key/account, dry, expiry, revoked consent, pending and error',()=>{
 const valid={preview:false,apiKey:'controlled-test-only',account:'fixture.near',quote:{dry:false,deadline:'2099-01-01T00:00:00Z'},accepted:true,pending:false};
 expect(canConfirm(valid)).toBe(true);
 for(const change of [{preview:true},{apiKey:undefined},{account:null},{quote:{dry:true,deadline:valid.quote.deadline}},{quote:{dry:false,deadline:'2000-01-01'}},{quote:{dry:false}},{accepted:false},{pending:true},{error:{code:'BALANCE'}}]) expect(canConfirm({...valid,...change})).toBe(false);
 });
});
