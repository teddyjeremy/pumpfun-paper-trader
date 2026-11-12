import { describe, expect, it } from "vitest";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount
} from "@pump-fun/pump-sdk";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  sellBaseInput
} from "@pump-fun/pump-sdk/swap";

describe("official Pump SDK package surface", () => {
  it("loads the official curve quote and online SDK exports", () => {
    expect(typeof OnlinePumpSdk).toBe("function");
    expect(PUMP_SDK).toBeDefined();
    expect(typeof getBuyV3TokenAmountFromQuoteAmount).toBe("function");
    expect(typeof getSellSolAmountFromTokenAmount).toBe("function");
  });

  it("loads the bundled official PumpSwap quote and online SDK exports", () => {
    expect(typeof OnlinePumpAmmSdk).toBe("function");
    expect(PUMP_AMM_SDK).toBeDefined();
    expect(typeof sellBaseInput).toBe("function");
  });
});
