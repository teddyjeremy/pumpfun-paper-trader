export type PositionMarketPhase="bonding_curve"|"migration_pending"|"migrated_market"|"exit_blocked"|"closed";
export type PositionVenue="pumpfun_curve"|"pumpswap";
export interface PositionLifecycle {
  positionId:string; mint:string; marketPhase:PositionMarketPhase; venue:PositionVenue|null;
  poolAddress:string|null; openedAt:string; migrationDetectedAt:string|null; migrationSlot:number|null;
  lastVerifiedQuoteAt:string|null; exitBlockedReason:string|null; tokenBalanceBaseUnits:string;
}
export function createCurvePosition(input:{positionId:string;mint:string;openedAt:string;tokenBalanceBaseUnits:string}):PositionLifecycle {
  return {...input,marketPhase:"bonding_curve",venue:"pumpfun_curve",poolAddress:null,migrationDetectedAt:null,migrationSlot:null,lastVerifiedQuoteAt:null,exitBlockedReason:null};
}
/** Graduation never closes the position or creates a sell fill. */
export function observeGraduation(position:PositionLifecycle,event:{observedAt:string;slot:number}):PositionLifecycle {
  if(position.marketPhase==="closed"||position.marketPhase==="migrated_market")return position;
  return {...position,marketPhase:"migration_pending",venue:null,poolAddress:null,migrationDetectedAt:position.migrationDetectedAt??event.observedAt,migrationSlot:position.migrationSlot??event.slot,exitBlockedReason:null};
}
export function verifyMigratedMarket(position:PositionLifecycle,proof:{
  venue:PositionVenue;poolAddress:string|null;mintVerified:boolean;poolVerified:boolean;
  freshExecutableSellQuote:boolean;tokenBalanceBaseUnits:string;verifiedAt:string;
}):PositionLifecycle {
  if(position.marketPhase==="closed")return position;
  const balanceValid=/^\d+$/.test(proof.tokenBalanceBaseUnits)&&BigInt(proof.tokenBalanceBaseUnits||"0")>0n;
  const valid=proof.venue==="pumpswap"&&!!proof.poolAddress&&proof.mintVerified&&proof.poolVerified&&proof.freshExecutableSellQuote&&balanceValid;
  if(!valid){
    const reasons=[proof.venue!=="pumpswap"?"venue is not enabled":null,!proof.poolAddress?"migrated pool address missing":null,!proof.mintVerified?"pool mint mismatch":null,!proof.poolVerified?"pool state unverified":null,!proof.freshExecutableSellQuote?"fresh full-position sell quote unavailable":null,!balanceValid?"held token balance unverified":null].filter((x):x is string=>x!==null);
    return {...position,marketPhase:"exit_blocked",venue:proof.venue==="pumpswap"?"pumpswap":null,poolAddress:proof.poolAddress,exitBlockedReason:reasons.join("; ")};
  }
  return {...position,marketPhase:"migrated_market",venue:"pumpswap",poolAddress:proof.poolAddress,tokenBalanceBaseUnits:proof.tokenBalanceBaseUnits,lastVerifiedQuoteAt:proof.verifiedAt,exitBlockedReason:null};
}
export function markExitBlocked(position:PositionLifecycle,reason:string):PositionLifecycle {
  return position.marketPhase==="closed"?position:{...position,marketPhase:"exit_blocked",exitBlockedReason:reason};
}
export function confirmPaperExit(position:PositionLifecycle,confirmation:{freshExecutableSellQuote:boolean;simulatedFillRecorded:boolean;tokenBalanceZeroConfirmed:boolean;exitedAt:string}):PositionLifecycle {
  if(position.marketPhase==="closed")return position;
  if(!confirmation.freshExecutableSellQuote||!confirmation.simulatedFillRecorded||!confirmation.tokenBalanceZeroConfirmed)
    return markExitBlocked(position,"position remains open: verified quote, simulated fill and zero-balance confirmation are required");
  return {...position,marketPhase:"closed",tokenBalanceBaseUnits:"0",lastVerifiedQuoteAt:confirmation.exitedAt,exitBlockedReason:null};
}
export function isPositionOpen(position:PositionLifecycle):boolean{return position.marketPhase!=="closed";}
export function shouldMonitorMigratedMarket(position:PositionLifecycle):boolean{return position.marketPhase==="migrated_market"||position.marketPhase==="exit_blocked";}
