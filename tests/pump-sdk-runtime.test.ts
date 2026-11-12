import { describe, expect, it } from "vitest";
import { officialPumpSdkModulesAvailable } from "../src/ingestion/pump-sdk-runtime.js";

describe("official Pump SDK runtime surface", () => {
  it("loads offline curve decoders and exact-quote pricing alongside PumpSwap pricing", () => {
    expect(officialPumpSdkModulesAvailable()).toEqual({ curve: true, pumpSwap: true });
  });
});
