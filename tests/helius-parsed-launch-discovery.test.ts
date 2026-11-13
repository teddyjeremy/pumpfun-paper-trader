import { describe, expect, it, vi } from "vitest";
import {
  fetchPumpCreateScanPage, fetchVerifiedParsedLaunch,
  canContinueParsedLaunchBucket, findFirstResumableParsedLaunchBucket, canMarkParsedLaunchBucketEmpty
} from "../src/ingestion/helius-parsed-launch-discovery.js";
import { PUMP_FUN_PROGRAM_ID } from "../src/ingestion/helius.js";

const signature = "5".repeat(88);
const discriminator = [27, 114, 169, 77, 222, 235, 99, 118];
const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(i * 8)) & 255n));
const string = (value: string) => {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...u32(bytes.length), ...bytes];
};
const pubkey = (n: number) => Array.from({ length: 32 }, () => n);
function createLog(timestamp: number): string {
  const bytes = [
    ...discriminator, ...string("Backtest"), ...string("BACK"), ...string("https://example.invalid"),
    ...pubkey(1), ...pubkey(2), ...pubkey(3), ...pubkey(4),
    ...u64(BigInt(timestamp)), ...u64(1_000_000n), ...u64(30_000_000_000n),
    ...u64(793_100_000_000_000n), ...u64(1_000_000_000_000_000n), ...pubkey(5),
    0, 0, ...pubkey(0), ...u64(0n), ...u64(0n), 0, 0
  ];
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return "Program data: " + btoa(binary);
}
const json = (value: unknown) => Response.json(value);

describe("Helius Parsed Events historical launch discovery", () => {


  it("never calls a bucket empty after a selected launch failed verification", () => {
    expect(canMarkParsedLaunchBucketEmpty({
      stoppedOn: "windowEnd", paginationToken: null, priorVerificationFailure: false
    })).toBe(true);
    expect(canMarkParsedLaunchBucketEmpty({
      stoppedOn: "windowEnd", paginationToken: null, priorVerificationFailure: true
    })).toBe(false);
    expect(canMarkParsedLaunchBucketEmpty({
      stoppedOn: "limit", paginationToken: null, priorVerificationFailure: false
    })).toBe(false);
  });

  it("keeps a failed selected transaction resumable while a bounded scan cursor remains", () => {
    expect(canContinueParsedLaunchBucket({
      paginationToken: "cursor:next", pagesScanned: 1, maxPagesPerBucket: 5
    })).toBe(true);
    expect(canContinueParsedLaunchBucket({
      paginationToken: null, pagesScanned: 1, maxPagesPerBucket: 5
    })).toBe(false);
    expect(canContinueParsedLaunchBucket({
      paginationToken: "cursor:last", pagesScanned: 5, maxPagesPerBucket: 5
    })).toBe(false);
  });

  it("resumes the earliest incomplete bucket with a safe cursor and remaining page allowance", () => {
    expect(findFirstResumableParsedLaunchBucket([
      { status: "FOUND", paginationToken: null, pagesScanned: 1 },
      { status: "INCOMPLETE", paginationToken: null, pagesScanned: 1 },
      { status: "RUNNING", paginationToken: "cursor:running", pagesScanned: 1 },
      { status: "INCOMPLETE", paginationToken: "cursor:2", pagesScanned: 2 },
      { status: "INCOMPLETE", paginationToken: "cursor:3", pagesScanned: 5 }
    ], 5)).toBe(2);
  });

  it("requests only Pump create instructions inside the exact time bucket", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({
      data: [{ signature, slot: 900, blockTime: 1_800 }],
      paginationToken: null,
      scan: { stoppedOn: "limit", scannedTransactions: 500, matchedTransactions: 1, creditsCharged: 11 }
    }));
    const page = await fetchPumpCreateScanPage({
      startTime: 1_700, endTime: 1_900
    }, { apiKey: "test", fetcher });
    expect(page).toMatchObject({
      data: [{ signature, slot: 900, blockTime: 1_800 }],
      stoppedOn: "limit", scannedTransactions: 500, creditsCharged: 11
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.address).toBe(PUMP_FUN_PROGRAM_ID);
    expect(body.match.programs[0].instructions).toEqual(["create", "create_v2"]);
    expect(body.time).toEqual({ gte: 1_700, lt: 1_900 });
    expect(body.budget.maxScannedTransactions).toBe(10_000);
  });

  it("retains empty budget pages and their pagination cursor for continuation", async () => {
    const page = await fetchPumpCreateScanPage({
      startTime: 1_700, endTime: 1_900, paginationToken: "cursor:1"
    }, { apiKey: "test", fetcher: async () => json({
      data: [], paginationToken: "cursor:2",
      scan: { stoppedOn: "budget", scannedTransactions: 10_000, matchedTransactions: 0, creditsCharged: 20 }
    }) });
    expect(page).toMatchObject({
      data: [], paginationToken: "cursor:2", stoppedOn: "budget", creditsCharged: 20
    });
  });

  it("independently decodes the selected CreateEvent against scan signature evidence", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({
      result: {
        slot: 900, blockTime: 1_800,
        transaction: { signatures: [signature] },
        meta: { err: null, logMessages: [
          `Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`,
          createLog(1_800)
        ] }
      }
    }));
    const launch = await fetchVerifiedParsedLaunch({
      signature, slot: 900, blockTime: 1_800
    }, { startTime: 1_700, endTime: 1_900 }, { apiKey: "test", fetcher });
    expect(launch).toMatchObject({ signature, slot: 900, blockTime: 1_800 });
    expect(launch.event.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("does not fall back to an unbounded crawl when Parsed Events is unavailable", async () => {
    await expect(fetchPumpCreateScanPage({
      startTime: 1_700, endTime: 1_900
    }, { apiKey: "test", fetcher: async () => new Response("", { status: 403 }) }))
      .rejects.toThrow(/Refusing to fall back/);
  });
});
