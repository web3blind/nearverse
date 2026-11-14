import {describe,expect,it} from 'vitest';
import type {Token} from '@aurora-is-near/intents-swap-widget/types';
import {routeFeeCost} from '../src/sdk/signing';
const near:Token={assetId:'native-near',decimals:24,blockchain:'near',symbol:'NEAR',price:3,icon:'',name:'NEAR',chainName:'Near',isIntent:false};
describe('one NEAR is a fee budget, not a turnover budget',()=>{
 it('does not book principal, even when a zero-fee exchange exceeds one NEAR',()=>{
  expect(routeFeeCost(near,'2000000000000000000000000','6','3')).toBe(0n);
  expect(routeFeeCost(near,'2000000000000000000000000','6','3',[{recipient:'fee.near',fee:10}])).toBe(2000000000000000000000n);
 });
 it('rounds fees up and prices only fees of non-NEAR input with a safety margin',()=>{
  const fees=[{recipient:'fee.near',fee:10}];
  expect(routeFeeCost({...near,assetId:'nep141:wrap.near',isIntent:true},'2000000000000000000000000','6','3',fees)).toBe(2000000000000000000000n);
  expect(routeFeeCost({...near,assetId:'nep141:usdc.near',decimals:6,isIntent:true},'6000000','6','3',fees)).toBe(2200000000000000000000n);
  expect(routeFeeCost(near,'1','0.000000000000000001','3',[{recipient:'fee.near',fee:1}])).toBe(1n);
 });
 it('rejects invalid fees or missing conversion prices instead of guessing a charge',()=>{
  for(const fee of [-1,0.5,10001])expect(()=>routeFeeCost(near,'100','1','3',[{recipient:'fee.near',fee}])).toThrow();
  expect(()=>routeFeeCost(near,'100','1','3',[{recipient:'a.near',fee:6000},{recipient:'b.near',fee:6000}])).toThrow();
  expect(()=>routeFeeCost({...near,assetId:'nep141:usdc.near'},'100','1','0',[{recipient:'fee.near',fee:10}])).toThrow();
 });
});
