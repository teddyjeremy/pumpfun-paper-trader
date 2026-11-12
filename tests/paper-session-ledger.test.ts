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
});

import { evaluateStrictStrategyAudit } from "../src/paper/strategy-audit.js";
describe("strict strategy audit", () => {
 const base = {
  candidateAgeSeconds: 25,
  profile: {impulsePriceChangePct:25,pullbackPct:20,reclaimDetected:true,reclaimAbovePreviousFiveSecondHighPct:1.4,pullbackVolumeVsImpulsePct:35,reclaimVolumeVsPullbackPct:180,dataComplete:true},
  flow: {dataComplete:true,latestThreeWindowFlowPass:true,windows:[1,2,3].map(()=>({buySellRatio:4,flowWindowPass:true,uniqueBuyers:4,uniqueSellers:1})),distinctBuyersAcrossLatestThree:7,largestBuyerShareAcrossLatestThreeBps:6500},
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
});
