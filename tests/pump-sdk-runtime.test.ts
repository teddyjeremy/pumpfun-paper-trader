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

  it("reports the installed SDK method surface without assuming undocumented names", () => {
    const surface = officialPumpSdkMethodSurface();
    console.info("PINNED_PUMP_SDK_METHOD_SURFACE", JSON.stringify(surface));
    expect(surface.curveStatic.length).toBeGreaterThan(0);
    expect(surface.curveOnline.length).toBeGreaterThan(0);
    expect(surface.pumpSwapStatic.length).toBeGreaterThan(0);
    expect(surface.pumpSwapOnline.length).toBeGreaterThan(0);
  });

  it("reports raw instruction-builder capabilities as explicit booleans", () => {
    const capabilities = officialPumpSdkInstructionCapabilities();
    for (const venue of Object.values(capabilities)) {
      expect(typeof venue.buy).toBe("boolean");
      expect(typeof venue.sell).toBe("boolean");
    }
  });
});
