import { describe, expect, it } from "vitest";
import { quotePumpSwapBuyFromSnapshot, quotePumpSwapSellFromSnapshot } from "../src/ingestion/pump-sdk-quote-adapter.js";

describe("official PumpSwap quote adapter safety gates", () => {
  it("rejects malformed buy budgets before decoding market state", () => {
    expect(() => quotePumpSwapBuyFromSnapshot({} as never, "0")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapBuyFromSnapshot({} as never, "-1")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapBuyFromSnapshot({} as never, "1.2")).toThrow(/positive base-unit/);
  });

  it("rejects malformed sell sizes before decoding market state", () => {
    expect(() => quotePumpSwapSellFromSnapshot({} as never, "0")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapSellFromSnapshot({} as never, "-1")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapSellFromSnapshot({} as never, "1.2")).toThrow(/positive base-unit/);
  });
});
