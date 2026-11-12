import { describe, expect, it } from "vitest";
import {
  applyAddressSignaturesPage,
  buildAddressSignaturesRequest,
  createHistoricalBackfillState,
  fetchHeliusAddressSignaturesPage
} from "../src/ingestion/helius-backfill.js";

const address = "So11111111111111111111111111111111111111112";
const mint = "So11111111111111111111111111111111111111112";
const create = "5".repeat(64);
const newer = "6".repeat(64);
const older = "7".repeat(64);

describe("bounded Helius historical backfill", () => {
  it("builds a standard address-history request with pagination", () => {
    const request = buildAddressSignaturesRequest(address, newer, 50);
    expect(request.method).toBe("getSignaturesForAddress");
    expect(request.params[1]).toEqual({ commitment: "confirmed", limit: 50, before: newer });
    expect(() => buildAddressSignaturesRequest(address, null, 1001)).toThrow(/limit/i);
  });


  it("fetches one Helius history page and returns a resumable continuation", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000
    });
    const result = await fetchHeliusAddressSignaturesPage(initial, {
      apiKey: "test-key",
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ result: [
          { signature: newer, slot: 12, blockTime: 1060, err: null }
        ] }), { status: 200 });
      }
    });
    expect((requestBody as any)?.method).toBe("getSignaturesForAddress");
    expect(result.status).toBe("CONTINUE");
    expect(result.state.before).toBe(newer);
  });

  it("fails closed on HTTP, JSON-RPC and malformed history responses", async () => {
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000
    });
    const httpFailure = await fetchHeliusAddressSignaturesPage(initial, {
      apiKey: "test-key", fetcher: async () => new Response("", { status: 503 })
    });
    const rpcFailure = await fetchHeliusAddressSignaturesPage(initial, {
      apiKey: "test-key", fetcher: async () => new Response(JSON.stringify({ error: { code: -1 } }), { status: 200 })
    });
    const malformed = await fetchHeliusAddressSignaturesPage(initial, {
      apiKey: "test-key", fetcher: async () => new Response(JSON.stringify({ result: {} }), { status: 200 })
    });
    expect(httpFailure.status).toBe("INCOMPLETE");
    expect(rpcFailure.status).toBe("INCOMPLETE");
    expect(malformed.status).toBe("INCOMPLETE");
  });

  it("marks complete only after reaching the verified create signature", () => {
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000
    });
    const result = applyAddressSignaturesPage(initial, [
      { signature: newer, slot: 12, blockTime: 1060, err: null },
      { signature: create, slot: 10, blockTime: 1000, err: null }
    ]);
    expect(result.status).toBe("COMPLETE");
    expect(result.state.status).toBe("COMPLETE");
    expect(result.signaturesToFetch.map(item => item.signature)).toEqual([newer, create]);
  });

  it("continues pagination when the create signature is not in the page", () => {
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000
    });
    const result = applyAddressSignaturesPage(initial, [
      { signature: newer, slot: 12, blockTime: 1060, err: null }
    ]);
    expect(result.status).toBe("CONTINUE");
    expect(result.state.before).toBe(newer);
  });

  it("never claims complete when the work cap is reached", () => {
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000, maxSignatures: 1
    });
    const result = applyAddressSignaturesPage(initial, [
      { signature: newer, slot: 12, blockTime: 1060, err: null }
    ]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.state.reason).toMatch(/cap/i);
  });

  it("rejects missing block time because coverage cannot be proven", () => {
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000
    });
    const result = applyAddressSignaturesPage(initial, [
      { signature: newer, slot: 12, blockTime: null, err: null }
    ]);
    expect(result.status).toBe("INCOMPLETE");
  });

  it("rejects history that crosses launch without finding the create signature", () => {
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000
    });
    const result = applyAddressSignaturesPage(initial, [
      { signature: older, slot: 9, blockTime: 999, err: null }
    ]);
    expect(result.status).toBe("INCOMPLETE");
  });

  it("does not start without a verified launch block time", () => {
    const state = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: null
    });
    expect(state.status).toBe("INCOMPLETE");
  });
  it("does not mark coverage complete when the create signature has no or mismatched block time", () => {
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000
    });
    const missing = applyAddressSignaturesPage(initial, [
      { signature: create, slot: 10, blockTime: null, err: null }
    ]);
    const mismatched = applyAddressSignaturesPage(initial, [
      { signature: create, slot: 10, blockTime: 1001, err: null }
    ]);
    expect(missing.status).toBe("INCOMPLETE");
    expect(mismatched.status).toBe("INCOMPLETE");
  });

  it("counts only records through the create signature when a provider page continues past the cap", () => {
    const initial = createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: 1000, maxSignatures: 120
    });
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      signature: "8".repeat(62) + alphabet[Math.floor(i / alphabet.length)] + alphabet[i % alphabet.length],
      slot: 200 - i, blockTime: 1100 - i, err: null
    }));
    const first = applyAddressSignaturesPage(initial, firstPage);
    expect(first.status).toBe("CONTINUE");
    const secondPage = [
      ...Array.from({ length: 19 }, (_, i) => ({
        signature: "9".repeat(63) + alphabet[i % alphabet.length],
        slot: 100 - i, blockTime: 1000, err: null
      })),
      { signature: create, slot: 10, blockTime: 1000, err: null }
    ];
    const second = applyAddressSignaturesPage(first.state, secondPage);
    expect(second.status).toBe("COMPLETE");
    expect(second.state.scannedCount).toBe(120);
    expect(second.signaturesToFetch).toHaveLength(120);
  });

  it("rejects invalid verified launch timestamps", () => {
    expect(() => createHistoricalBackfillState({
      mint, bondingCurve: address, createSignature: create, launchBlockTime: Number.NaN
    })).toThrow(/launch block time/);
  });

});
