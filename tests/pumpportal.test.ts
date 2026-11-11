import { describe, expect, it } from "vitest";
import {
  buildPumpPortalDiscoveryUrl,
  parsePumpPortalDiscoveryMessage,
  pumpPortalDiscoverySubscriptions
} from "../src/ingestion/pumpportal.js";

const mint = "So11111111111111111111111111111111111111112";
const creator = "11111111111111111111111111111111";
const signature = "5".repeat(88);

describe("PumpPortal free discovery adapter primitives", () => {
  it("uses the data endpoint without an API key or wallet credential", () => {
    expect(buildPumpPortalDiscoveryUrl()).toBe("wss://pumpportal.fun/api/data");
    expect(buildPumpPortalDiscoveryUrl()).not.toContain("api-key");
  });

  it("subscribes only to free new-token and migration discovery", () => {
    expect(pumpPortalDiscoverySubscriptions()).toEqual([
      { method: "subscribeNewToken" },
      { method: "subscribeMigration" }
    ]);
    expect(JSON.stringify(pumpPortalDiscoverySubscriptions())).not.toMatch(/subscribe(Token|Account)Trade/);
  });

  it("normalizes a new-token message and preserves raw provider fields", () => {
    const result = parsePumpPortalDiscoveryMessage({
      txType: "create",
      mint,
      traderPublicKey: creator,
      signature,
      name: "Example",
      symbol: "EX",
      uri: "https://example.invalid/token.json",
      initialBuy: 1.25,
      solAmount: 1.25,
      marketCapSol: 25
    }, "2026-11-12T12:00:00.000Z");

    expect(result.status).toBe("EVENT");
    if (result.status !== "EVENT") return;
    expect(result.event).toMatchObject({
      provider: "pumpportal",
      kind: "new_token",
      mint,
      creator,
      signature,
      name: "Example",
      receivedAt: "2026-11-12T12:00:00.000Z"
    });
    expect(result.event.raw.initialBuy).toBe(1.25);
  });

  it("normalizes migration events without assuming they are entry-eligible", () => {
    const result = parsePumpPortalDiscoveryMessage({ txType: "migrate", mint, signature });
    expect(result.status).toBe("EVENT");
    if (result.status === "EVENT") expect(result.event.kind).toBe("migration");
  });

  it("ignores trade messages instead of accidentally consuming metered trade streams", () => {
    expect(parsePumpPortalDiscoveryMessage({ txType: "buy", mint })).toMatchObject({ status: "IGNORED" });
    expect(parsePumpPortalDiscoveryMessage({ txType: "sell", mint })).toMatchObject({ status: "IGNORED" });
  });

  it("marks malformed JSON and missing/invalid mint as incomplete", () => {
    expect(parsePumpPortalDiscoveryMessage("{")).toMatchObject({ status: "DATA_INCOMPLETE" });
    expect(parsePumpPortalDiscoveryMessage({ txType: "create" })).toMatchObject({ status: "DATA_INCOMPLETE" });
    expect(parsePumpPortalDiscoveryMessage({ txType: "create", mint: "not-a-mint" })).toMatchObject({ status: "DATA_INCOMPLETE" });
  });

  it("does not invent creator or signature values when provider omits them", () => {
    const result = parsePumpPortalDiscoveryMessage({ txType: "create", mint });
    expect(result.status).toBe("EVENT");
    if (result.status === "EVENT") {
      expect(result.event.creator).toBeNull();
      expect(result.event.signature).toBeNull();
    }
  });

  it("rejects malformed optional addresses rather than trusting them", () => {
    expect(parsePumpPortalDiscoveryMessage({ txType: "create", mint, traderPublicKey: "bad" }))
      .toMatchObject({ status: "DATA_INCOMPLETE" });
  });
});
