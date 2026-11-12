import {describe,expect,it} from "vitest";
import {hydrateHistoricalRiskEvidence} from "../src/strategy/historical-risk-evidence.js";

const mint="So11111111111111111111111111111111111111112";
const owner="11111111111111111111111111111111";
const walletB="Vote111111111111111111111111111111111111111";

describe("historical risk evidence hydration",()=>{
  it("hydrates observed holder snapshots with their original observation timestamp",()=>{
    const result=hydrateHistoricalRiskEvidence({
      mint,
      events:[{occurredAt:"2026-11-12T10:00:00.000Z",payload:{
        evidenceType:"HOLDER_CONCENTRATION",
        result:{status:"OBSERVED",snapshot:{
          mint,observedAt:"2026-11-12T09:59:00.000Z",coverage:"TOP_20_TOKEN_ACCOUNTS_ONLY",
          dataComplete:false,accounts:[{owner,amount:"25000000",shareBps:2500}]
        }}
      }}]
    });
    expect(result.walletHoldings).toEqual([{
      mint,wallet:owner,amount:"25000000",observedAt:"2026-11-12T09:59:00.000Z"
    }]);
    expect(result.holderCensusCompleteAt).toBeUndefined();
  });

  it("hydrates observed links but keeps recent-signature sampling reject-only",()=>{
    const result=hydrateHistoricalRiskEvidence({
      mint,
      events:[{occurredAt:"2026-11-12T10:00:00.000Z",payload:{
        evidenceType:"WALLET_CLUSTER",
        fundingEvidence:{
          status:"OBSERVED",coverage:"RECENT_SIGNATURE_SAMPLE_ONLY",
          observedAt:"2026-11-12T09:59:30.000Z",
          links:[{
            mint,walletA:owner,walletB,confidenceBps:8000,
            evidence:["COMMON_FUNDER","REPEATED_FUNDING"],
            observedAt:"2026-11-12T09:59:00.000Z"
          }]
        }
      }}]
    });
    expect(result.walletLinks).toHaveLength(1);
    expect(result.walletClusterEvidenceCoverage).toBe("RECENT_SIGNATURE_SAMPLE_ONLY");
    expect(result.walletClusterEvidenceCompleteAt).toBeUndefined();
  });

  it("does not promote complete-looking evidence when the event archive is truncated",()=>{
    const result=hydrateHistoricalRiskEvidence({
      mint,truncated:true,eventCount:501,
      events:[{occurredAt:"2026-11-12T10:00:00.000Z",payload:{
        evidenceType:"WALLET_CLUSTER",
        fundingEvidence:{
          status:"OBSERVED",coverage:"FULL_WALLET_HISTORY",
          observedAt:"2026-11-12T09:59:30.000Z",links:[]
        }
      }},{occurredAt:"2026-11-12T10:00:00.000Z",payload:{
        evidenceType:"HOLDER_CONCENTRATION",
        result:{status:"OBSERVED",snapshot:{
          observedAt:"2026-11-12T09:59:30.000Z",coverage:"FULL_HOLDER_CENSUS",
          dataComplete:true,accounts:[{owner,amount:"1"}]
        }}
      }}]
    });
    expect(result.riskEvidenceTruncated).toBe(true);
    expect(result.walletClusterEvidenceCoverage).toBe("RECENT_SIGNATURE_SAMPLE_ONLY");
    expect(result.walletClusterEvidenceCompleteAt).toBeUndefined();
    expect(result.holderCensusCompleteAt).toBeUndefined();
  });

  it("ignores malformed, mismatched-mint and future-unparseable evidence",()=>{
    const result=hydrateHistoricalRiskEvidence({
      mint,
      events:[{occurredAt:"bad",payload:{
        evidenceType:"WALLET_CLUSTER",
        fundingEvidence:{coverage:"RECENT_SIGNATURE_SAMPLE_ONLY",links:[{
          mint:"different",walletA:owner,walletB,confidenceBps:8000,
          evidence:["COMMON_FUNDER"],observedAt:"bad"
        }]}
      }},{occurredAt:"bad",payload:"not-json"}]
    });
    expect(result.walletLinks).toHaveLength(0);
    expect(result.walletHoldings).toHaveLength(0);
    expect(result.walletClusterEvidenceCoverage).toBe("RECENT_SIGNATURE_SAMPLE_ONLY");
  });

  it("does not accept a partial link with unknown evidence kinds",()=>{
    const result=hydrateHistoricalRiskEvidence({
      mint,
      events:[{occurredAt:"2026-11-12T10:00:00.000Z",payload:{
        evidenceType:"WALLET_CLUSTER",
        fundingEvidence:{coverage:"RECENT_SIGNATURE_SAMPLE_ONLY",links:[{
          mint,walletA:owner,walletB,confidenceBps:8000,
          evidence:["UNKNOWN_KIND"],observedAt:"2026-11-12T09:59:00.000Z"
        }]}
      }}]
    });
    expect(result.walletLinks).toHaveLength(0);
  });
});
