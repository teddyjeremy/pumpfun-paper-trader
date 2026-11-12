import { describe, expect, it } from "vitest";
import { discoverCanonicalPumpSwapPoolForMint, discoverPumpSwapPoolsForMint, fetchHeliusMultipleAccounts } from "../src/ingestion/helius-accounts.js";
import { PUMP_AMM_PROGRAM_ID } from "../src/ingestion/pump-account-decoder.js";

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

  it("discovers mint-matched PumpSwap pools but only selects the SDK-identified canonical pool", async () => {
    const data = new Uint8Array(271);
    data.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
    data[8] = 254;
    data[9] = 0; data[10] = 0;
    const payload = {
      result: { context: { slot: 321 }, value: [{
        pubkey: "canonical-pool",
        account: { owner: PUMP_AMM_PROGRAM_ID, data: [encoded(Array.from(data)), "base64"] }
      }] }
    };
    const fetcher = async (_url: unknown, _init?: RequestInit) => response(payload);
    const config = { apiKey: "test", now: () => Date.parse("2026-11-12T12:00:00.000Z"), fetcher };
    const discovered = await discoverPumpSwapPoolsForMint("11111111111111111111111111111111", config);
    expect(discovered).toMatchObject({ contextSlot: 321, pools: [{ address: "canonical-pool", index: 0 }] });
    const selected = await discoverCanonicalPumpSwapPoolForMint({
      mint: "11111111111111111111111111111111",
      expectedPoolAddress: "canonical-pool",
      expectedPoolCreatorAuthority: "11111111111111111111111111111111",
      config
    });
    expect(selected?.pool.address).toBe("canonical-pool");
    const notCanonical = await discoverCanonicalPumpSwapPoolForMint({
      mint: "11111111111111111111111111111111",
      expectedPoolAddress: "other-pool",
      expectedPoolCreatorAuthority: "11111111111111111111111111111111",
      config
    });
    expect(notCanonical).toBeNull();
  });

  it("bounds PumpSwap discovery candidates and rejects non-PumpSwap accounts", async () => {
    const data = new Uint8Array(271);
    data.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
    await expect(discoverPumpSwapPoolsForMint("11111111111111111111111111111111", {
      apiKey: "test", maxPoolCandidates: 0, fetcher: async () => response({
        result: { context: { slot: 1 }, value: [] }
      })
    })).rejects.toThrow(/between 1 and 50/);
    await expect(discoverPumpSwapPoolsForMint("11111111111111111111111111111111", {
      apiKey: "test", fetcher: async () => response({
        result: { context: { slot: 1 }, value: [{
          pubkey: "fake", account: { owner: "not-pump", data: [encoded(Array.from(data)), "base64"] }
        }] }
      })
    })).rejects.toThrow(/not owned/);
  });

});
