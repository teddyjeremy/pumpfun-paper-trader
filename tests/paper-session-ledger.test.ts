import { describe, expect, it } from "vitest";
import { calculateCandidateOutcome, createBankrollState, markPaperEquity, replenishPaperBankroll } from "../src/paper/session-ledger.js";
describe("paper bankroll and missed-candidate outcomes", () => {
 it("starts at $2.70", () => expect(createBankrollState()).toMatchObject({initialBankrollUsd:2.7,currentEquityUsd:2.7,totalCapitalContributedUsd:2.7,topUpCount:0}));
 it("does not top up at exactly $1", () => expect(replenishPaperBankroll(markPaperEquity(createBankrollState(),1),"2026-11-12T12:00:00Z").event).toBeNull());
 it("adds $2.70 below $1 and records each top-up", () => {
  const first=replenishPaperBankroll(markPaperEquity(createBankrollState(),0.72),"2026-11-12T12:00:00Z");
  expect(first.state).toMatchObject({totalTopUpsUsd:2.7,topUpCount:1,currentEquityUsd:3.42,totalCapitalContributedUsd:5.4});
  expect(first.event?.data).toMatchObject({replenishmentNumber:1,balanceBeforeUsd:0.72,amountAddedUsd:2.7,balanceAfterUsd:3.42});
  const second=replenishPaperBankroll(markPaperEquity(first.state,0.5),"2026-11-12T13:00:00Z");
  expect(second.state).toMatchObject({topUpCount:2,totalTopUpsUsd:5.4,totalCapitalContributedUsd:8.1});
 });
 it("measures a rejected coin from both rejection and discovery prices", () => {
  const out=calculateCandidateOutcome({mint:"mint-1",decision:"REJECT",decisionAt:"2026-11-12T12:00:00Z",decisionPriceUsd:0.000002,discoveryPriceUsd:0.000001,observedPricesUsd:[{priceUsd:0.000006,observedAt:"2026-11-12T12:20:00Z"}],rejectionReasons:["LOW_BUYER_COUNT","LOW_BUYER_COUNT"],followUpStatus:"COMPLETE"});
  expect(out).toMatchObject({maxMultipleFromDecision:3,maxMultipleFromDiscovery:6,reached15x:true,reached2x:true,reached3x:true,rejectionReasons:["LOW_BUYER_COUNT"]});
 });
 it("does not fabricate multiples without observations or a reference price", () => {
  const out=calculateCandidateOutcome({mint:"mint-2",decision:"WATCH",decisionAt:"2026-11-12T12:00:00Z",decisionPriceUsd:null,discoveryPriceUsd:null,observedPricesUsd:[],followUpStatus:"MISSING"});
  expect(out.maxMultipleFromDecision).toBeNull(); expect(out.reached3x).toBe(false); expect(out.followUpStatus).toBe("MISSING");
 });
});

import { updateCandidatePriceTracker } from "../src/paper/candidate-price-ledger.js";
describe("candidate price follow-up ledger", () => {
 it("tracks peaks and milestones from the first observed trade in the same quote mint", () => {
  const first = updateCandidatePriceTracker(null, {mint:"mint",quoteMint:"SOL",quoteAmount:"100",tokenAmount:"1000",timestamp:"2026-11-12T12:00:00Z",signature:"sig1",isBuy:true});
  const peak = updateCandidatePriceTracker(first, {mint:"mint",quoteMint:"SOL",quoteAmount:"300",tokenAmount:"1000",timestamp:"2026-11-12T12:01:00Z",signature:"sig2",isBuy:false});
  expect(peak.multipleFromFirstObserved).toBe(3);
  expect(peak.reached15x).toBe(true); expect(peak.reached2x).toBe(true); expect(peak.reached3x).toBe(true);
  expect(peak.followUpStatus).toBe("PARTIAL");
 });
 it("does not compare prices across quote mints", () => {
  const first = updateCandidatePriceTracker(null, {mint:"mint",quoteMint:"SOL",quoteAmount:"100",tokenAmount:"1000",timestamp:"2026-11-12T12:00:00Z",signature:"sig1",isBuy:true});
  expect(() => updateCandidatePriceTracker(first, {mint:"mint",quoteMint:"USDC",quoteAmount:"300",tokenAmount:"1000",timestamp:"2026-11-12T12:01:00Z",signature:"sig2",isBuy:false})).toThrow();
 });
 it("measures post-decision peaks from the decision baseline, not earlier highs", () => {
  const beforeDecision = updateCandidatePriceTracker(null, {
   mint:"mint-2",quoteMint:"SOL",quoteAmount:"400",tokenAmount:"1000",
   timestamp:"2026-11-12T11:59:00Z",signature:"pre",isBuy:true,
   decisionPriceQuotePerToken:0.2,decisionAt:"2026-11-12T12:00:00Z",
   discoveryPriceQuotePerToken:0.1
  });
  const afterDecision = updateCandidatePriceTracker(beforeDecision, {
   mint:"mint-2",quoteMint:"SOL",quoteAmount:"150",tokenAmount:"1000",
   timestamp:"2026-11-12T12:01:00Z",signature:"post-1",isBuy:false
  });
  expect(afterDecision.maxMultipleFromDecision).toBe(1);
  const laterPeak = updateCandidatePriceTracker(afterDecision, {
   mint:"mint-2",quoteMint:"SOL",quoteAmount:"400",tokenAmount:"1000",
   timestamp:"2026-11-12T12:02:00Z",signature:"post-2",isBuy:true
  });
  expect(laterPeak.maxMultipleFromDecision).toBe(2);
  expect(laterPeak.reached2xFromDecision).toBe(true);
  expect(laterPeak.reached2xFromDecisionAt).toBe("2026-11-12T12:02:00Z");
  expect(laterPeak.maxMultipleFromDiscovery).toBe(4);
 });
});

import { evaluateStrictStrategyAudit, calculateReclaimConfirmation } from "../src/paper/strategy-audit.js";
describe("strict strategy audit", () => {
 const base = {
  candidateAgeSeconds: 25,
  profile: {impulsePriceChangePct:25,pullbackPct:20,reclaimDetected:true,reclaimAbovePreviousFiveSecondHighPct:1.4,pullbackVolumeVsImpulsePct:35,reclaimVolumeVsPullbackPct:180,dataComplete:true},
  flow: {dataComplete:true,latestThreeWindowFlowPass:true,windows:[1,2,3].map(()=>({buySellRatio:4,flowWindowPass:true,uniqueBuyers:4,uniqueSellers:1})),distinctBuyersAcrossLatestThree:7,largestBuyerShareAcrossLatestThreeBps:6500,microTradeFilterStatus:"APPLIED"},
  creatorRiskStatus:"PASS_COMPLETE",walletClusterRiskStatus:"WATCH",attributionConfidenceBps:7500,
  signalAgeSeconds:1.5,nextObservationConfirmed:true,executableQuoteAvailable:false
 };
 it("records known passes but never permits a buy while quote and volume thresholds are unknown", () => {
  const result=evaluateStrictStrategyAudit(base);
  expect(result.decision).toBe("WATCH"); expect(result.buyAllowed).toBe(false);
  expect(result.blockingUnknownRules).toContain("PULLBACK_VOLUME_CONTRACTION");
  expect(result.blockingUnknownRules).toContain("EXECUTABLE_QUOTE");
  expect(result.rules.find(rule=>rule.rule==="IMPULSE")?.status).toBe("PASS");
 });
 it("rejects a confirmed creator risk breach", () => {
  const result=evaluateStrictStrategyAudit({...base,creatorRiskStatus:"REJECT_OBSERVED"});
  expect(result.decision).toBe("REJECT"); expect(result.rejectionReasons).toContain("CREATOR_SELL_RISK");
 });
 it("rejects a known failed strategy condition instead of leaving it on watch", () => {
  const result=evaluateStrictStrategyAudit({...base,profile:{...base.profile,impulsePriceChangePct:12}});
  expect(result.decision).toBe("REJECT");
  expect(result.rejectionReasons).toContain("IMPULSE");
 });
 it("accepts completed windows with zero sells when the source confirms the strict volume rule", () => {
  const noSellFlow = {...base, flow:{...base.flow,
    windows:[1,2,3].map(()=>({buySellRatio:null,flowWindowPass:true,uniqueBuyers:4,uniqueSellers:0}))}};
  const result=evaluateStrictStrategyAudit(noSellFlow);
  expect(result.rules.find(rule=>rule.rule==="THREE_FLOW_WINDOWS")?.status).toBe("PASS");
 });
 it("keeps price-pattern rules UNKNOWN when the profile coverage is incomplete", () => {
  const result=evaluateStrictStrategyAudit({...base,profile:{...base.profile,dataComplete:false}});
  expect(result.rules.find(rule=>rule.rule==="IMPULSE")?.status).toBe("UNKNOWN");
  expect(result.rules.find(rule=>rule.rule==="PULLBACK")?.status).toBe("UNKNOWN");
  expect(result.rules.find(rule=>rule.rule==="RECLAIM")?.status).toBe("UNKNOWN");
 });
 it("confirms reclaim only with a later observation at least 1% above the previous completed high", () => {
  const result=calculateReclaimConfirmation({reclaimTimeSeconds:100,previousCompletedHigh:1,nowSeconds:101.5,
   nextObservationPrices:[{timestampSeconds:101,price:1.012}]});
  expect(result).toEqual({signalAgeSeconds:1.5,nextObservationConfirmed:true});
  const failed=calculateReclaimConfirmation({reclaimTimeSeconds:100,previousCompletedHigh:1,nowSeconds:101.5,
   nextObservationPrices:[{timestampSeconds:101,price:1.005}]});
  expect(failed.nextObservationConfirmed).toBe(false);
 });
});

 it("does not count a pre-rejection peak as post-rejection performance", () => {
  const pre = updateCandidatePriceTracker(null, {
   mint:"mint",quoteMint:"SOL",quoteAmount:"300",tokenAmount:"1000",
   timestamp:"2026-11-12T12:00:00Z",signature:"before",isBuy:true,
   discoveryPriceQuotePerToken:0.1
  });
  const after = updateCandidatePriceTracker(pre, {
   mint:"mint",quoteMint:"SOL",quoteAmount:"260",tokenAmount:"1000",
   timestamp:"2026-11-12T12:06:00Z",signature:"after",isBuy:true,
   decisionPriceQuotePerToken:0.25,decisionAt:"2026-11-12T12:05:00Z",
   discoveryPriceQuotePerToken:0.1
  });
  expect(after.maxMultipleFromDiscovery).toBe(3);
  expect(after.maxMultipleFromDecision).toBeCloseTo(1.04);
  expect(after.reached3xFromDecision).toBe(false);
 });
 it("uses the rejection price as the initial 1x post-decision high-water mark", () => {
  const after = updateCandidatePriceTracker(null, {
   mint:"mint",quoteMint:"SOL",quoteAmount:"90",tokenAmount:"1000",
   timestamp:"2026-11-12T12:06:00Z",signature:"after",isBuy:true,
   decisionPriceQuotePerToken:0.25,decisionAt:"2026-11-12T12:05:00Z",
   discoveryPriceQuotePerToken:0.1
  });
  expect(after.maxMultipleFromDecision).toBe(1);
  expect(after.decisionPeakPriceQuotePerToken).toBe(0.25);
  expect(after.decisionPeakObservedAt).toBe("2026-11-12T12:05:00Z");
 });
