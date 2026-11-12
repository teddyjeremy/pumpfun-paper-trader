import { describe, expect, it } from "vitest";
import {
  officialPumpSdkInstructionCapabilities,
  officialPumpSdkMethodSurface,
  officialPumpSdkModulesAvailable
} from "../src/ingestion/pump-sdk-runtime.js";

describe("official Pump SDK runtime surface", () => {
  it("loads the pinned offline curve and PumpSwap pricing modules", () => {
    expect(officialPumpSdkModulesAvailable()).toEqual({ curve: true, pumpSwap: true });
  });

  it("records static exports and online prototype surfaces independently", () => {
    const surface = officialPumpSdkMethodSurface();
    console.info("PINNED_PUMP_SDK_METHOD_SURFACE", JSON.stringify(surface));
    expect(surface.curveStatic.length).toBeGreaterThan(0);
    expect(surface.pumpSwapStatic.length).toBeGreaterThan(0);
    // The pinned SDK exposes these instruction builders on static SDK objects.
    // Empty online prototypes are valid and must not make module inspection fail.
    expect(Array.isArray(surface.curveOnline)).toBe(true);
    expect(Array.isArray(surface.pumpSwapOnline)).toBe(true);
  });

  it("reports instruction-builder capabilities only when the pinned runtime exports them", () => {
    const capabilities = officialPumpSdkInstructionCapabilities();
    expect(capabilities).toEqual({
      curveV3: { buyExactTokens: true, buyExactQuoteIn: true, sellExactTokens: true },
      curveV2: { buyExactTokens: true, buyExactQuoteIn: false, sellExactTokens: true },
      pumpSwapV2: { buyExactTokens: true, buyExactQuoteIn: true, sellExactTokens: true }
    });
  });
});
