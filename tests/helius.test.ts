import { describe, expect, it, vi } from "vitest";
import {
  buildCandidateLogsSubscribe,
  buildHeliusRpcUrl,
  buildHeliusWebSocketUrl,
  fetchAndVerifyPumpTransaction,
  parseHeliusLogsNotification
} from "../src/ingestion/helius.js";

const signature = "5".repeat(88);
const mint = "So11111111111111111111111111111111111111112";
const curve = "11111111111111111111111111111111";
const apiKey = "test-secret-key";

describe("Helius standard RPC endpoints", () => {
  it("builds HTTPS and WSS URLs without exposing the key in diagnostics", () => {
    expect(buildHeliusRpcUrl(apiKey)).toBe("https://mainnet.helius-rpc.com/?api-key=test-secret-key");
    expect(buildHeliusWebSocketUrl(apiKey)).toBe("wss://mainnet.helius-rpc.com/?api-key=test-secret-key");
    expect(() => buildHeliusRpcUrl(" ")).toThrow(/required/);
  });

  it("builds one-address standard logsSubscribe requests at confirmed commitment", () => {
    expect(buildCandidateLogsSubscribe(curve, 7)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "logsSubscribe",
      params: [{ mentions: [curve] }, { commitment: "confirmed" }]
    });
    expect(() => buildCandidateLogsSubscribe("bad", 7)).toThrow(/address/);
    expect(() => buildCandidateLogsSubscribe(curve, 0)).toThrow(/request ID/);
  });

  it("parses only complete logsNotification messages", () => {
    expect(parseHeliusLogsNotification({
      method: "logsNotification",
      params: { result: { context: { slot: 123 }, value: { signature, err: null, logs: [] } } }
    })).toEqual({ signature, slot: 123, err: null });
    expect(parseHeliusLogsNotification({ method: "accountNotification" })).toBeNull();
    expect(parseHeliusLogsNotification({
      method: "logsNotification",
      params: { result: { context: { slot: -1 }, value: { signature, err: null } } }
    })).toBeNull();
  });
});

describe("selective Helius transaction fetch", () => {
  it("requests one confirmed transaction using standard getTransaction", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("getTransaction");
      expect(body.params[0]).toBe(signature);
      expect(body.params[1]).toMatchObject({
        encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0
      });
      return Response.json({ jsonrpc: "2.0", id: signature, result: null });
    });
    const result = await fetchAndVerifyPumpTransaction(signature, mint, { apiKey, fetcher });
    expect(result).toMatchObject({ status: "DATA_INCOMPLETE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not turn unavailable transactions into empty market observations", async () => {
    const fetcher = vi.fn(async () => Response.json({ jsonrpc: "2.0", result: null }));
    const result = await fetchAndVerifyPumpTransaction(signature, mint, { apiKey, fetcher });
    expect(result).toEqual({
      status: "DATA_INCOMPLETE",
      reason: "Transaction is not available at the requested commitment."
    });
  });

  it("fails closed on RPC errors, HTTP errors and transport failures", async () => {
    const rpcError = await fetchAndVerifyPumpTransaction(signature, mint, {
      apiKey, fetcher: async () => Response.json({ error: { code: -32000 } })
    });
    expect(rpcError.status).toBe("DATA_INCOMPLETE");

    const httpError = await fetchAndVerifyPumpTransaction(signature, mint, {
      apiKey, fetcher: async () => new Response("unavailable", { status: 429 })
    });
    expect(httpError).toMatchObject({ status: "DATA_INCOMPLETE", reason: "Helius HTTP status 429." });

    const networkError = await fetchAndVerifyPumpTransaction(signature, mint, {
      apiKey, fetcher: async () => { throw new Error("network"); }
    });
    expect(networkError.status).toBe("DATA_INCOMPLETE");
  });

  it("rejects invalid signature or mint before making a request", async () => {
    const fetcher = vi.fn();
    expect((await fetchAndVerifyPumpTransaction("bad", mint, { apiKey, fetcher })).status).toBe("DATA_INCOMPLETE");
    expect((await fetchAndVerifyPumpTransaction(signature, "bad", { apiKey, fetcher })).status).toBe("DATA_INCOMPLETE");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
