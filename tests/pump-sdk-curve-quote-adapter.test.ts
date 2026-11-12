import { describe, expect, it } from "vitest";
import {
  fetchPumpCurveSdkQuote,
  quotePumpCurveBuyFromSnapshot,
  quotePumpCurveSellFromSnapshot
} from "../src/ingestion/pump-sdk-curve-quote-adapter.js";

describe("official Pump curve quote adapter safety gates", () => {
  it("rejects malformed buy budgets before decoding market state", () => {
    expect(() => quotePumpCurveBuyFromSnapshot({} as never, "0")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveBuyFromSnapshot({} as never, "-1")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveBuyFromSnapshot({} as never, "1.2")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveBuyFromSnapshot({} as never, "18446744073709551616")).toThrow(/positive base-unit/);
  });

  it("rejects malformed sell sizes before decoding market state", () => {
    expect(() => quotePumpCurveSellFromSnapshot({} as never, "0")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveSellFromSnapshot({} as never, "-1")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveSellFromSnapshot({} as never, "1.2")).toThrow(/positive base-unit/);
    expect(() => quotePumpCurveSellFromSnapshot({} as never, "18446744073709551616")).toThrow(/positive base-unit/);
  });

  it("does not issue Helius reads for malformed quote sizes", async () => {
    let called = false;
    await expect(fetchPumpCurveSdkQuote({
      mint: "So11111111111111111111111111111111111111112",
      side: "BUY", amountBaseUnits: "18446744073709551616",
      config: { apiKey: "test", fetcher: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      } }
    })).rejects.toThrow(/positive base-unit/);
    expect(called).toBe(false);
  });
});
