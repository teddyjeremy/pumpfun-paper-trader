import {describe,expect,it} from "vitest";
import {createPumpUnsignedPlanFeeEvidenceBuilder,fetchExecutableRoundTripQuote} from "../src/ingestion/executable-quote-service.js";
import type {OfflinePumpQuote} from "../src/ingestion/executable-paper-quote.js";
import type {UnsignedInstructionFeeEvidence} from "../src/ingestion/solana-fee-estimator.js";

const mint="So11111111111111111111111111111111111111112";
const observedAt="2026-11-12T12:00:00.000Z";
const solUsd={source:"binance-spot" as const,symbol:"SOLUSDT" as const,priceUsd:150,observedAt};
function quote(side:"BUY"|"SELL",slot:number,amount:string):OfflinePumpQuote {
  const common={
    provider:"pump-sdk-4.3.1" as const,side,mint,quoteMint:"11111111111111111111111111111111",
    slot,observedAt,inputAmountBaseUnits:amount,outputAmountBaseUnits:side==="BUY"?"1000000":"100000000",
    grossQuoteAmountBaseUnits:side==="BUY"?"100000000":"101000000",
    netQuoteAmountBaseUnits:side==="BUY"?"100000000":"100000000",
    baseDecimals:6,quoteDecimals:9,transferTaxVerifiedZero:true as const,
    executionReady:false as const,blockers:[],priceImpactPct:0.5
  };
  if(side==="BUY") return {...common,venue:"PUMP_CURVE" as const,venueFeeBaseUnits:"0"};
  return {...common,venue:"PUMP_CURVE" as const,venueFeeBaseUnits:"1000000"};
}

function exactFeeEvidence(networkFeeLamports:string,priorityFeeLamports:string):UnsignedInstructionFeeEvidence {
  const estimate={
    provider:"helius-solana-rpc" as const,commitment:"confirmed" as const,
    networkFeeLamports,priorityFeeLamports,priorityFeeMicroLamportsPerCu:"1000",
    computeUnitLimit:200_000,feeMessageSha256:"a".repeat(64),sampleCount:10,
    firstSampleSlot:90,lastSampleSlot:99,observedSlot:100,
    observedAt,priorityPercentile:75 as const
  };
  return {
    status:"AVAILABLE",messageSha256:"a".repeat(64),
    writableAccountKeys:["11111111111111111111111111111111"],
    computeUnitLimit:200_000,estimate
  };
}

describe("executable quote service",()=>{
  it("requires an exact-size fresh sell quote on the same venue and quote mint",async()=>{
    let calls=0;
    const result=await fetchExecutableRoundTripQuote({
      fetchQuote:async({side,amountBaseUnits})=>{
        calls++;
        return side==="BUY"?quote("BUY",100,amountBaseUnits):{
          ...quote("SELL",101,amountBaseUnits),inputAmountBaseUnits:amountBaseUnits
        };
      },
      helius:{apiKey:"test",fetcher:async()=>new Response(JSON.stringify({
        result:[{slot:99,prioritizationFee:1000},{slot:100,prioritizationFee:2000}]
      }),{status:200})},
      buyAmountBaseUnits:"100000000",computeUnitLimit:200_000,
      solUsd,now:()=>Date.parse(observedAt),executionDelayMs:100
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("QUOTES_VALIDATED");
    expect(result.paperEntryAuthorized).toBe(false);
    expect(result.sellability.quoteSellable).toBe(true);
    expect(result.sellability.tokenAmountBaseUnits).toBe("1000000");
    expect(result.sellability.sellSlot).toBeGreaterThan(result.sellability.buySlot);
    expect(result.economics.roundTripNetReturnPct).toBeLessThan(0);
    expect(result.economics.roundTripCostPct).toBeGreaterThan(2);
    expect(result.economics.roundTripCostPct).toBeLessThan(2.1);
    expect(result.economics.meetsRoundTripCostLimit).toBe(true);
    expect(result.economics.meetsMinimumNetReturn).toBe(false);
  });
  it("blocks when the sell quote does not match the exact buy output",async()=>{
    await expect(fetchExecutableRoundTripQuote({
      fetchQuote:async({side,amountBaseUnits})=>side==="BUY"?quote("BUY",100,amountBaseUnits):{
        ...quote("SELL",101,amountBaseUnits),inputAmountBaseUnits:"999"
      },
      helius:{apiKey:"test",fetcher:async()=>new Response(JSON.stringify({
        result:[{slot:99,prioritizationFee:0}]
      }),{status:200})},
      buyAmountBaseUnits:"100000000",computeUnitLimit:200_000,solUsd,now:()=>Date.parse(observedAt)
    })).rejects.toThrow(/exact net token output/);
  });
  it("blocks when buy and sell quotes describe different markets",async()=>{
    await expect(fetchExecutableRoundTripQuote({
      fetchQuote:async({side,amountBaseUnits})=>side==="BUY"?quote("BUY",100,amountBaseUnits):{
        ...quote("SELL",101,amountBaseUnits),mint:"different-mint"
      },
      helius:{apiKey:"test",fetcher:async()=>new Response(JSON.stringify({
        result:[{slot:99,prioritizationFee:0}]
      }),{status:200})},
      buyAmountBaseUnits:"100000000",computeUnitLimit:200_000,solUsd,now:()=>Date.parse(observedAt)
    })).rejects.toThrow(/same mint, venue and quote mint/);
  });
  it("reports a failed combined fee and impact budget without authorizing an entry",async()=>{
    const result=await fetchExecutableRoundTripQuote({
      fetchQuote:async({side,amountBaseUnits})=>({
        ...quote(side,side==="BUY"?100:101,amountBaseUnits),
        priceImpactPct:3,
        ...(side==="SELL"?{grossQuoteAmountBaseUnits:"110000000",venueFeeBaseUnits:"10000000"}:{})
      }),
      helius:{apiKey:"test",fetcher:async()=>new Response(JSON.stringify({
        result:[{slot:99,prioritizationFee:1000}]
      }),{status:200})},
      buyAmountBaseUnits:"100000000",computeUnitLimit:200_000,solUsd,
      now:()=>Date.parse(observedAt),maxPriceImpactPct:5,maximumRoundTripCostPct:4
    });
    expect(result.status).toBe("QUOTES_VALIDATED");
    expect(result.economics.roundTripCostPct).toBeGreaterThan(4);
    expect(result.economics.meetsRoundTripCostLimit).toBe(false);
    expect(result.paperEntryAuthorized).toBe(false);
  });
  it("blocks when a buy quote has excessive price impact",async()=>{
    await expect(fetchExecutableRoundTripQuote({
      fetchQuote:async({side,amountBaseUnits})=>({
        ...quote(side,100,amountBaseUnits),priceImpactPct:3
      }),
      helius:{apiKey:"test",fetcher:async()=>new Response(JSON.stringify({
        result:[{slot:99,prioritizationFee:0}]
      }),{status:200})},
      buyAmountBaseUnits:"100000000",computeUnitLimit:200_000,solUsd,now:()=>Date.parse(observedAt)
    })).rejects.toThrow(/maximum price impact/);
  });
});


describe("exact unsigned plan fee evidence adapter",()=>{
  it("fails closed without a verified quote snapshot and never authorizes signing or submission",async()=>{
    const buildExactFeeEvidence=createPumpUnsignedPlanFeeEvidenceBuilder({
      identity:{
        kind:"NON_SIGNING_VIRTUAL_TRADER",publicKey:"11111111111111111111111111111111",
        derivationVersion:1,canSign:false,canSubmit:false
      },
      config:{apiKey:"test"},
      computeUnitLimit:200_000
    });
    const evidence=await buildExactFeeEvidence({
      side:"BUY",quote:quote("BUY",100,"100000000")
    });
    expect(evidence.status).toBe("UNAVAILABLE");
    if(evidence.status==="UNAVAILABLE") {
      expect(evidence.reason).toMatch(/verified same-context account snapshot/);
    }
  });
});
