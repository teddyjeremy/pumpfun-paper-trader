import { describe, expect, it } from "vitest";
import {
  officialPumpSdkInstructionCapabilities,
  officialPumpSdkModulesAvailable
} from "../src/ingestion/pump-sdk-runtime.js";

describe("official Pump SDK runtime surface", () => {
  it("loads offline curve decoders, quote math and PumpSwap pricing", () => {
    const available = officialPumpSdkModulesAvailable();
    expect(available).toEqual({ curve: true, pumpSwap: true });
  });

  it("reports raw instruction-builder availability independently from authorization", () => {
    const capabilities = officialPumpSdkInstructionCapabilities();
    expect(capabilities.curveV3.buy).toBe(true);
    expect(capabilities.curveV3.sell).toBe(true);
    expect(capabilities.curveV2.buy).toBe(true);
    expect(capabilities.curveV2.sell).toBe(true);
    expect(capabilities.pumpSwapV2.buy).toBe(true);
    expect(capabilities.pumpSwapV2.sell).toBe(true);
  });
});
