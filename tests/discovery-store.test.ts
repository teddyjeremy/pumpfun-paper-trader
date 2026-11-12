import { describe, expect, it } from "vitest";
import {
  applyDiscoveryEvent,
  emptyDiscoveryStore,
  pruneExpiredCandidates,
  type DiscoveryInput
} from "../src/ingestion/discovery-store.js";

const mintA = "So11111111111111111111111111111111111111112";
const mintB = "11111111111111111111111111111111";
const event = (overrides: Partial<DiscoveryInput> = {}): DiscoveryInput => ({
  kind: "new_token",
  mint: mintA,
  signature: null,
  creator: null,
  bondingCurve: null,
  name: "Example",
  symbol: "EX",
  receivedAt: "2026-11-12T00:00:00.000Z",
  ...overrides
});

describe("bounded discovery candidate store", () => {
  it("adds a new candidate without claiming it is verified", () => {
    const result = applyDiscoveryEvent(emptyDiscoveryStore(), event());
    expect(result.outcome).toBe("ADDED");
    expect(result.state.candidates[0]).toMatchObject({
      mint: mintA,
      status: "DISCOVERED",
      observations: 1
    });
  });

  it("deduplicates by mint and enriches only fields actually supplied", () => {
    const first = applyDiscoveryEvent(emptyDiscoveryStore(), event());
    const second = applyDiscoveryEvent(first.state, event({
      signature: "5".repeat(88),
      creator: mintB,
      receivedAt: "2026-11-12T00:00:02.000Z"
    }));
    expect(second.outcome).toBe("UPDATED");
    expect(second.state.candidates).toHaveLength(1);
    expect(second.state.candidates[0]).toMatchObject({
      signature: "5".repeat(88),
      creator: mintB,
      observations: 2
    });
    expect(second.state.duplicates).toBe(1);
  });

  it("marks an existing candidate migrated without removing its history", () => {
    const first = applyDiscoveryEvent(emptyDiscoveryStore(), event());
    const second = applyDiscoveryEvent(first.state, event({
      kind: "migration",
      receivedAt: "2026-11-12T00:00:04.000Z"
    }));
    expect(second.state.candidates[0]).toMatchObject({
      status: "MIGRATED",
      observations: 2
    });
    expect(second.state.migrations).toBe(1);
  });

  it("retains a migration event even when its create event was missed", () => {
    const result = applyDiscoveryEvent(emptyDiscoveryStore(), event({
      kind: "migration",
      mint: mintB
    }));
    expect(result.state.candidates[0]).toMatchObject({
      mint: mintB,
      status: "MIGRATED"
    });
  });

  it("rejects a candidate beyond the configured cap and records its mint as a gap", () => {
    const first = applyDiscoveryEvent(emptyDiscoveryStore(), event(), { cap: 1 });
    const second = applyDiscoveryEvent(first.state, event({ mint: mintB }), { cap: 1 });
    expect(second.outcome).toBe("OVERFLOW");
    expect(second.state.candidates).toHaveLength(1);
    expect(second.state.overflow).toBe(1);
    expect(second.state.overflowMints).toContain(mintB);
  });

  it("expires candidates after the retention window before admitting new ones", () => {
    const first = applyDiscoveryEvent(emptyDiscoveryStore(), event());
    const second = applyDiscoveryEvent(first.state, event({ mint: mintB }), {
      now: "2026-11-12T00:16:00.000Z",
      cap: 1
    });
    expect(second.outcome).toBe("ADDED");
    expect(second.state.candidates.map((candidate) => candidate.mint)).toEqual([mintB]);
  });

  it("marks invalid or future receipt timestamps as incomplete", () => {
    const invalid = applyDiscoveryEvent(emptyDiscoveryStore(), event({ receivedAt: "bad" }));
    expect(invalid.outcome).toBe("INVALID_TIME");
    expect(invalid.state.incomplete).toBe(1);
  });
});


describe("discovery retention during idle periods", () => {
  it("expires candidates on a sweep even when no new launch arrives", () => {
    const first = applyDiscoveryEvent(emptyDiscoveryStore(), event());
    const swept = pruneExpiredCandidates(first.state, "2026-11-12T00:16:00.000Z");
    expect(swept.candidates).toHaveLength(0);
    expect(swept.expired).toBe(1);
    expect(swept.accepted).toBe(1);
  });

  it("keeps fresh candidates and leaves the state unchanged when nothing expires", () => {
    const first = applyDiscoveryEvent(emptyDiscoveryStore(), event());
    expect(pruneExpiredCandidates(first.state, "2026-11-12T00:01:00.000Z")).toEqual(first.state);
  });

  it("marks an invalid sweep time incomplete instead of deleting candidates", () => {
    const first = applyDiscoveryEvent(emptyDiscoveryStore(), event());
    const swept = pruneExpiredCandidates(first.state, "invalid");
    expect(swept.candidates).toHaveLength(1);
    expect(swept.incomplete).toBe(1);
  });
});
