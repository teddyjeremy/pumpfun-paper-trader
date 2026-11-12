import {
  OnlinePumpSdk,
  PUMP_SDK,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  getBuyV3QuoteAmountFromTokenAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getBuyTokenAmountFromSolAmount,
  getBuySolAmountFromTokenAmount,
  getSellSolAmountFromTokenAmount,
  computeFeesBps
} from "@pump-fun/pump-sdk";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  buyQuoteInput,
  sellBaseInput
} from "@pump-fun/pump-sdk/swap";

/**
 * Verifies the offline pricing and account-decoding APIs are bundled alongside
 * the online SDK classes. This does not create a Connection, read chain state,
 * quote a trade, build a transaction or sign.
 */
export function officialPumpSdkModulesAvailable(): {
  curve: boolean;
  pumpSwap: boolean;
} {
  return {
    curve: typeof OnlinePumpSdk === "function" &&
      typeof PUMP_SDK.decodeBondingCurve === "function" &&
      typeof PUMP_SDK.decodeGlobal === "function" &&
      typeof PUMP_SDK.decodeFeeConfig === "function" &&
      GLOBAL_PDA instanceof Object && PUMP_FEE_CONFIG_PDA instanceof Object &&
      typeof getBuyV3QuoteAmountFromTokenAmount === "function" &&
      typeof getBuyV3TokenAmountFromQuoteAmount === "function" &&
      typeof getBuyTokenAmountFromSolAmount === "function" &&
      typeof getBuySolAmountFromTokenAmount === "function" &&
      typeof getSellSolAmountFromTokenAmount === "function" &&
      typeof computeFeesBps === "function",
    pumpSwap: typeof OnlinePumpAmmSdk === "function" &&
      typeof PUMP_AMM_SDK === "object" &&
      typeof buyQuoteInput === "function" &&
      typeof sellBaseInput === "function"
  };
}
