import {describe,expect,it} from "vitest";
import {buildPaperNetworkFeeEstimate,fetchHeliusPriorityFeeSamples} from "../src/ingestion/helius-priority-fee.js";

describe("Helius paper priority fee estimation",()=>{
  it("fetches and validates bounded recent prioritization fee samples",async()=>{
    const result=await fetchHeliusPriorityFeeSamples({
      config:{apiKey:"test-key",fetcher:async()=>new Response(JSON.stringify({
        result:[{slot:10,prioritizationFee:0},{slot:11,prioritizationFee:1000},{slot:12,prioritizationFee:5000}]
      }),{status:200})}
    });
    expect(result).toHaveLength(3);
    expect(result[2]?.microLamportsPerComputeUnit).toBe("5000");
  });
  it("calculates the percentile priority fee in lamports using the CU limit",()=>{
    const estimate=buildPaperNetworkFeeEstimate({
      samples:[0,1000,2000,3000,4000].map((value,index)=>({
        slot:index+1,microLamportsPerComputeUnit:String(value)
      })),
      computeUnitLimit:200_000,priorityFeePercentile:75
    });
    expect(estimate.networkFeeLamports).toBe("5000");
    expect(estimate.microLamportsPerComputeUnit).toBe("3000");
    expect(estimate.priorityFeeLamports).toBe("600");
  });
  it("returns zero priority fee only when the provider explicitly reports zero samples",()=>{
    const estimate=buildPaperNetworkFeeEstimate({
      samples:[{slot:1,microLamportsPerComputeUnit:"0"}],computeUnitLimit:200_000
    });
    expect(estimate.priorityFeeLamports).toBe("0");
    expect(estimate.nonZeroSampleCount).toBe(0);
  });
  it("fails closed when the estimate exceeds the configured fee cap",()=>{
    expect(()=>buildPaperNetworkFeeEstimate({
      samples:[{slot:1,microLamportsPerComputeUnit:"100000"}],
      computeUnitLimit:200_000,maxPriorityFeeLamports:"100"
    })).toThrow(/exceeds the configured paper cost cap/);
  });
  it("rejects malformed fee samples and invalid compute limits",()=>{
    expect(()=>buildPaperNetworkFeeEstimate({
      samples:[{slot:1,microLamportsPerComputeUnit:"-1"}],computeUnitLimit:200_000
    })).toThrow();
    expect(()=>buildPaperNetworkFeeEstimate({
      samples:[{slot:1,microLamportsPerComputeUnit:"0"}],computeUnitLimit:1_500_000
    })).toThrow();
  });
  it("rejects malformed RPC payloads",async()=>{
    await expect(fetchHeliusPriorityFeeSamples({
      config:{apiKey:"test-key",fetcher:async()=>new Response(JSON.stringify({result:[]}),{status:200})}
    })).rejects.toThrow(/no samples/);
  });
});
