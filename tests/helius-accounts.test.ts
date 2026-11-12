import { describe, expect, it } from "vitest";
import { fetchHeliusMultipleAccounts } from "../src/ingestion/helius-accounts.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
const encoded = (bytes: number[]) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

describe("Helius same-slot account snapshots", () => {
  it("returns related account bytes with one shared context slot", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const result = await fetchHeliusMultipleAccounts(["pool", "base-vault", "quote-vault"], {
      apiKey: "test-key", now: () => Date.parse("2026-11-12T12:00:00.000Z"),
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          jsonrpc: "2.0", id: "paper-account-snapshot",
          result: { context: { slot: 123 }, value: [
            { owner: "pump-amm", data: [encoded([1, 2, 3]), "base64"] },
            { owner: "spl-token", data: [encoded([4, 5]), "base64"] },
            null
          ] }
        });
      }
    });
    expect(requestBody).toMatchObject({ method: "getMultipleAccounts", params: [
      ["pool", "base-vault", "quote-vault"], { encoding: "base64", commitment: "confirmed" }
    ] });
    expect(result.slot).toBe(123);
    expect(result.accounts[0]).toMatchObject({
      address: "pool", owner: "pump-amm", slot: 123,
      observedAt: "2026-11-12T12:00:00.000Z", data: new Uint8Array([1, 2, 3])
    });
    expect(result.accounts[2]).toBeNull();
  });

  it("rejects missing, duplicate or excessive account addresses", async () => {
    await expect(fetchHeliusMultipleAccounts([], { apiKey: "test" })).rejects.toThrow(/between 1 and 100/);
    await expect(fetchHeliusMultipleAccounts(["same", "same"], { apiKey: "test" })).rejects.toThrow(/unique/);
    await expect(fetchHeliusMultipleAccounts(Array.from({ length: 101 }, (_, i) => String(i)), { apiKey: "test" }))
      .rejects.toThrow(/between 1 and 100/);
  });

  it("fails closed on an incomplete response, RPC error or invalid base64", async () => {
    await expect(fetchHeliusMultipleAccounts(["a"], {
      apiKey: "test", fetcher: async () => response({ result: { context: { slot: 1 }, value: [] } })
    })).rejects.toThrow(/incomplete/);
    await expect(fetchHeliusMultipleAccounts(["a"], {
      apiKey: "test", fetcher: async () => response({ error: { code: -32000 } })
    })).rejects.toThrow(/JSON-RPC error/);
    await expect(fetchHeliusMultipleAccounts(["a"], {
      apiKey: "test", fetcher: async () => response({
        result: { context: { slot: 1 }, value: [{ owner: "x", data: ["***", "base64"] }] }
      })
    })).rejects.toThrow(/base64/);
  });

  it("rejects stale/malformed context slots and account-size abuse", async () => {
    await expect(fetchHeliusMultipleAccounts(["a"], {
      apiKey: "test", fetcher: async () => response({
        result: { context: { slot: -1 }, value: [null] }
      })
    })).rejects.toThrow(/context slot/);
    await expect(fetchHeliusMultipleAccounts(["a"], {
      apiKey: "test", maxAccountBytes: 2, fetcher: async () => response({
        result: { context: { slot: 1 }, value: [{ owner: "x", data: [encoded([1, 2, 3]), "base64"] }] }
      })
    })).rejects.toThrow(/size limit/);
  });
});
