import {describe,expect,it} from "vitest";
import {calculateActiveStopPct,DYNAMIC_EXIT_CALIBRATION_V1,evaluateExit,type ExitWindowObservation} from "../src/strategy/dynamic-exits.js";

const w=(x:Partial<ExitWindowObservation>={}):ExitWindowObservation=>({
  endedAtMs:10_000,windowSeconds:5,complete:true,buySellRatio:2,buyVolumeDeclinePct:5,
  buyerRateDeclinePct:0,sellVolumeExpansionPct:0,priceResponseDeclinePct:0,
  liquidityChangePct:0,largeHolderDistributionDetected:false,...x
});
const evaluate=(windows:ExitWindowObservation[])=>evaluateExit({
  currentNetReturnPct:18,highestCompletedNetReturnPct:25,
  freshExecutableSellQuote:true,windowsOldestFirst:windows
},DYNAMIC_EXIT_CALIBRATION_V1);

describe("dynamic paper exit evaluator",()=>{
  it("uses -5% hard stop before trailing activation",()=>{expect(calculateActiveStopPct(0)).toBe(-5);expect(evaluateExit({currentNetReturnPct:-5.1,highestCompletedNetReturnPct:0,freshExecutableSellQuote:true,windowsOldestFirst:[]}).reason).toBe("hard_stop");});
  it("locks +5% after +10% has been reached",()=>{expect(calculateActiveStopPct(10)).toBe(5);expect(evaluateExit({currentNetReturnPct:4.9,highestCompletedNetReturnPct:10,freshExecutableSellQuote:true,windowsOldestFirst:[]}).reason).toBe("protective_stop");});
  it("never lowers a previously active stop",()=>{expect(calculateActiveStopPct(50,20)).toBe(20);});
  it("does not sell because time passed or a window is missing",()=>{const r=evaluateExit({currentNetReturnPct:12,highestCompletedNetReturnPct:12,freshExecutableSellQuote:true,windowsOldestFirst:[w({complete:false}),w({endedAtMs:15_000})]});expect(r.action).toBe("hold");});
  it("requires two independent evidence families in each of two consecutive windows",()=>{
    const r=evaluate([w({endedAtMs:10_000,buySellRatio:.8,buyVolumeDeclinePct:45}),w({endedAtMs:15_000,buySellRatio:.7,buyerRateDeclinePct:45})]);
    expect(r.action).toBe("sell");expect(r.reason).toBe("dynamic_exhaustion");expect(r.bearishSignalsByWindow).toEqual([2,2]);
  });
  it("does not double-count correlated indicators within one evidence family",()=>{
    const r=evaluate([w({endedAtMs:10_000,buySellRatio:.8,sellVolumeExpansionPct:80}),w({endedAtMs:15_000,buySellRatio:.7,sellVolumeExpansionPct:90})]);
    expect(r.action).toBe("hold");
  });
  it("allows one independent bearish family to trigger after three consecutive complete windows",()=>{
    const r=evaluate([w({endedAtMs:10_000,buySellRatio:.8}),w({endedAtMs:15_000,buySellRatio:.7}),w({endedAtMs:20_000,buySellRatio:.6})]);
    expect(r.action).toBe("sell");expect(r.reason).toBe("dynamic_exhaustion");expect(r.bearishSignalsByWindow).toEqual([1,1,1]);
  });
  it("does not allow a single-family trigger across a missing or discontinuous window",()=>{
    const r=evaluate([w({endedAtMs:10_000,buySellRatio:.8}),w({endedAtMs:15_000,complete:false,buySellRatio:.7}),w({endedAtMs:20_000,buySellRatio:.6})]);
    expect(r.action).toBe("hold");
  });
  it("supports interleaved window durations without mixing them",()=>{
    const r=evaluate([
      w({endedAtMs:10_000,windowSeconds:2,buySellRatio:.8}),
      w({endedAtMs:11_000,windowSeconds:5,buySellRatio:2}),
      w({endedAtMs:12_000,windowSeconds:2,buySellRatio:.7}),
      w({endedAtMs:13_000,windowSeconds:5,buySellRatio:2}),
      w({endedAtMs:14_000,windowSeconds:2,buySellRatio:.6})
    ]);
    expect(r.action).toBe("sell");
  });
  it("does not treat missing measurements as zero",()=>{const r=evaluate([w({endedAtMs:10_000,buySellRatio:null,buyVolumeDeclinePct:null}),w({endedAtMs:15_000,buySellRatio:null,buyerRateDeclinePct:null})]);expect(r.action).toBe("hold");});
  it("blocks an exit if no fresh full-position sell quote exists",()=>{const r=evaluateExit({currentNetReturnPct:-6,highestCompletedNetReturnPct:0,freshExecutableSellQuote:false,windowsOldestFirst:[]});expect(r.action).toBe("exit_blocked");expect(r.triggerReason).toBe("hard_stop");});
  it("lets emergency risk override soft signals",()=>{const r=evaluateExit({currentNetReturnPct:20,highestCompletedNetReturnPct:25,emergencyReason:"creator distribution detected",freshExecutableSellQuote:true,windowsOldestFirst:[]});expect(r.reason).toBe("emergency_risk");});
});
