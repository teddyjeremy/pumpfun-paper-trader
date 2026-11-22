import { describe, expect, it } from "vitest";
import { parseProviderFeeUsdPerTransaction } from "../src/ingestion/provider-fee.js";

describe("per-transaction provider fee configuration", () => {
  it("treats a missing or malformed assumption as unknown", () => {
    for (const raw of [undefined, "", "   ", "NaN", "Infinity", "-0.01", "0x10", "1e-3", "1.2.3"]) {
      expect(parseProviderFeeUsdPerTransaction(raw)).toBeNull();
    }
  });

  it("accepts an explicitly reviewed zero or non-negative decimal amount", () => {
    expect(parseProviderFeeUsdPerTransaction("0")).toBe(0);
    expect(parseProviderFeeUsdPerTransaction(" 0.00 ")).toBe(0);
    expect(parseProviderFeeUsdPerTransaction("0.025")).toBe(0.025);
    expect(parseProviderFeeUsdPerTransaction("12")).toBe(12);
  });
});
