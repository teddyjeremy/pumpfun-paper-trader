import {describe,expect,it} from "vitest";
import {getFreshExecutableQuoteCostPct} from "../src/ingestion/executable-quote-eligibility.js";

const now=Date.parse("2026-11-13T10:00:00.000Z");
function evidence(overrides:Record<string,unknown>={}) {
  return {
    status:"QUOTES_VALIDATED",
    validatedAt:new Date(now-500).toISOString(),
    result:{
      status:"QUOTES_VALIDATED",
      buyQuote:{mint:"mint-1",venue:"PUMP_CURVE",expiresAt:new Date(now+1_000).toISOString()},
      initialSellQuote:{mint:"mint-1",venue:"PUMP_CURVE",expiresAt:new Date(now+1_000).toISOString()},
      exactFeeEvidence:{buy:{status:"AVAILABLE"},sell:{status:"AVAILABLE"}},
      economics:{roundTripCostPct:2.5,meetsRoundTripCostLimit:true}
    },
    ...overrides
  };
}

describe("fresh executable quote eligibility",()=>{
  it("accepts fresh same-mint quotes with both exact fee legs and an acceptable cost",()=>{
    expect(getFreshExecutableQuoteCostPct(evidence(),"mint-1",now)).toBe(2.5);
  });
  it("rejects stale or future-dated quote evidence",()=>{
    expect(getFreshExecutableQuoteCostPct(evidence({
      validatedAt:new Date(now-2_001).toISOString()
    }),"mint-1",now)).toBeNull();
    expect(getFreshExecutableQuoteCostPct(evidence({
      validatedAt:new Date(now+1).toISOString()
    }),"mint-1",now)).toBeNull();
  });
  it("rejects expired, mismatched or one-sided fee evidence",()=>{
    const expired=evidence();
    (expired.result as any).buyQuote.expiresAt=new Date(now-1).toISOString();
    expect(getFreshExecutableQuoteCostPct(expired,"mint-1",now)).toBeNull();
    const mismatch=evidence();
    (mismatch.result as any).initialSellQuote.mint="mint-2";
    expect(getFreshExecutableQuoteCostPct(mismatch,"mint-1",now)).toBeNull();
    const oneFee=evidence();
    (oneFee.result as any).exactFeeEvidence.sell.status="UNAVAILABLE";
    expect(getFreshExecutableQuoteCostPct(oneFee,"mint-1",now)).toBeNull();
  });
  it("rejects round-trip costs that fail the configured limit",()=>{
    const failed=evidence();
    (failed.result as any).economics.meetsRoundTripCostLimit=false;
    expect(getFreshExecutableQuoteCostPct(failed,"mint-1",now)).toBeNull();
  });
});
