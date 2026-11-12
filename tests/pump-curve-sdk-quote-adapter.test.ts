import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  quotePumpCurveBuyFromSdkState, quotePumpCurveSellFromSdkState,
  type PumpCurveSdkQuoteState
} from "../src/ingestion/pump-curve-sdk-quote-adapter.js";
import type { BondingCurve, Global } from "@pump-fun/pump-sdk";

function state(): PumpCurveSdkQuoteState {
  const curve = {
    virtualTokenReserves: new BN("1000000000000"),
    virtualQuoteReserves: new BN("30000000000"),
    realTokenReserves: new BN("800000000000"),
    realQuoteReserves: new BN("15000000000"),
    tokenTotalSupply: new BN("1000000000000000"),
    complete: false, creator: PublicKey.default, isMayhemMode: false,
    isCashbackCoin: false, quoteMint: PublicKey.default,
    creatorFeeBps: new BN(0)
  } as BondingCurve;
  const global = {
    feeBasisPoints: new BN(100), creatorFeeBasisPoints: new BN(50),
    creatorFeeConfigurable: false
  } as Global;
  return {
    global, feeConfig: null, bondingCurve: curve,
    mint: new PublicKey("So11111111111111111111111111111111111111112"),
    slot: 100, observedAt: "2026-11-12T10:00:00.000Z", baseDecimals: 6
  };
}

describe("official Pump bonding-curve SDK quote adapter", () => {
  it("uses the SDK exact-input buy and reconciles the gross cost, fee and unused budget", () => {
    const quote = quotePumpCurveBuyFromSdkState(state(), "1000000000");
    expect(quote.venue).toBe("pump-bonding-curve");
    expect(quote.side).toBe("BUY");
    expect(BigInt(quote.outputAmountBaseUnits)).toBeGreaterThan(0n);
    expect(BigInt(quote.grossQuoteAmountBaseUnits) + BigInt(quote.unspentQuoteBaseUnits))
      .toBe(1_000_000_000n);
    expect(BigInt(quote.fees.totalBaseUnits)).toBe(BigInt(quote.fees.protocolBaseUnits));
    expect(quote.executionReady).toBe(false);
  });

  it("uses the SDK sell quote and reconciles protocol/creator fees", () => {
    const quote = quotePumpCurveSellFromSdkState(state(), "10000000000");
    expect(quote.side).toBe("SELL");
    expect(BigInt(quote.grossQuoteAmountBaseUnits) - BigInt(quote.netQuoteAmountBaseUnits))
      .toBe(BigInt(quote.fees.totalBaseUnits));
    expect(BigInt(quote.outputAmountBaseUnits)).toBeGreaterThan(0n);
  });

  it("rejects invalid u64 sizes and curves that are complete or migrated", () => {
    expect(() => quotePumpCurveBuyFromSdkState(state(), "184467440737095516150")).toThrow(/positive u64/);
    expect(() => quotePumpCurveSellFromSdkState(state(), "0")).toThrow(/positive u64/);
    expect(() => quotePumpCurveBuyFromSdkState({
      ...state(), bondingCurve: { ...state().bondingCurve, complete: true } as BondingCurve
    }, "1000")).toThrow(/complete, migrated/);
  });
});
