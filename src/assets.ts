// Exact asset identities from the Aurora production token inventory. A symbol
// alone is never sufficient to select a token or prove route liquidity.
export const assetIds = {
  NEAR:'nep141:wrap.near', BTC:'nep141:nbtc.bridge.near', ETH:'nep141:eth.omft.near',
  USDC:'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  SOL:'nep141:sol.omft.near', USDT:'nep141:usdt.tether-token.near',
} as const;
export type Asset = keyof typeof assetIds;
export function targetAssetId(symbol:string|undefined):string|undefined {
  return symbol && Object.hasOwn(assetIds,symbol) ? assetIds[symbol as Asset] : undefined;
}
export function supportedToken(token:{assetId:string;isIntent:boolean;blockchain:string}):boolean {
  return token.isIntent ? Object.values(assetIds).some(id=>id===token.assetId) : token.blockchain==='near' && (token.assetId==='native-near' || token.assetId===assetIds.USDC || token.assetId===assetIds.USDT);
}
