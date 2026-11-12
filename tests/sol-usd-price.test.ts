import { describe, expect, it } from "vitest";
import { fetchSolUsdPrice } from "../src/ingestion/sol-usd-price.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("SOL/USD notional reference", () => {
  it("accepts a valid fresh SOLUSDT last-trade observation", async () => {
    const result = await fetchSolUsdPrice({
      nowMs: 100_000,
      fetcher: async () => response({ symbol: "SOLUSDT", lastPrice: "150.25", closeTime: 96_000 })
    });
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.observation).toMatchObject({
        source: "binance-spot", symbol: "SOLUSDT", priceUsd: 150.25,
        observedAt: new Date(96_000).toISOString(), ageMs: 4_000
      });
    }
  });

  it("fails closed when the last trade is stale", async () => {
    const result = await fetchSolUsdPrice({
      nowMs: 100_000,
      fetcher: async () => response({ symbol: "SOLUSDT", lastPrice: "150.25", closeTime: 80_000 })
    });
    expect(result).toMatchObject({ status: "UNAVAILABLE", reason: "SOL/USD last trade is stale or has an invalid future timestamp." });
  });

  it("rejects malformed prices and mismatched symbols", async () => {
    const invalidPrice = await fetchSolUsdPrice({
      nowMs: 100_000,
      fetcher: async () => response({ symbol: "SOLUSDT", lastPrice: "NaN", closeTime: 99_000 })
    });
    const invalidSymbol = await fetchSolUsdPrice({
      nowMs: 100_000,
      fetcher: async () => response({ symbol: "BTCUSDT", lastPrice: "100", closeTime: 99_000 })
    });
    expect(invalidPrice.status).toBe("UNAVAILABLE");
    expect(invalidSymbol.status).toBe("UNAVAILABLE");
  });

  it("fails closed on provider errors", async () => {
    const httpError = await fetchSolUsdPrice({ fetcher: async () => response({}, 429) });
    const networkError = await fetchSolUsdPrice({ fetcher: async () => { throw new Error("offline"); } });
    expect(httpError.status).toBe("UNAVAILABLE");
    expect(networkError.status).toBe("UNAVAILABLE");
  });
});
