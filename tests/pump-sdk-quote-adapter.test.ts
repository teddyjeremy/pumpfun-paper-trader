import { describe, expect, it } from "vitest";
import {
  fetchPumpSwapSdkQuote,
  quotePumpSwapBuyFromSnapshot,
  quotePumpSwapSellFromSnapshot
} from "../src/ingestion/pump-sdk-quote-adapter.js";

describe("official PumpSwap quote adapter safety gates", () => {
  it("rejects malformed buy budgets before decoding market state", () => {
    expect(() => quotePumpSwapBuyFromSnapshot({} as never, "0")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapBuyFromSnapshot({} as never, "-1")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapBuyFromSnapshot({} as never, "1.2")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapBuyFromSnapshot({} as never, "18446744073709551616")).toThrow(/positive base-unit/);
  });

  it("does not quote when the discovery read cannot find the canonical pool", async () => {
    await expect(fetchPumpSwapSdkQuote({
      mint: "So11111111111111111111111111111111111111112",
      poolAddress: "So11111111111111111111111111111111111111112",
      side: "SELL",
      amountBaseUnits: "1000",
      config: {
        apiKey: "test-key",
        fetcher: async () => new Response(JSON.stringify({
          jsonrpc: "2.0", id: "paper-account-snapshot",
          result: { context: { slot: 55 }, value: [null] }
        }), { status: 200 })
      }
    })).rejects.toThrow(/pool account is not available/);
  });

  it("rejects malformed sell sizes before decoding market state", () => {
    expect(() => quotePumpSwapSellFromSnapshot({} as never, "0")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapSellFromSnapshot({} as never, "-1")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapSellFromSnapshot({} as never, "1.2")).toThrow(/positive base-unit/);
    expect(() => quotePumpSwapSellFromSnapshot({} as never, "18446744073709551616")).toThrow(/positive base-unit/);
  });
});
