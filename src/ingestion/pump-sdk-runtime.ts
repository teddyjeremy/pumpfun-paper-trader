import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount
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
      typeof getBuyV3TokenAmountFromQuoteAmount === "function" &&
      typeof getSellSolAmountFromTokenAmount === "function",
    pumpSwap: typeof OnlinePumpAmmSdk === "function" &&
      typeof PUMP_AMM_SDK === "object" &&
      typeof buyQuoteInput === "function" &&
      typeof sellBaseInput === "function"
  };
}
