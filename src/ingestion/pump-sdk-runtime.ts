import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-sdk/swap";

/**
 * A build/runtime module-resolution check only. This does not create a
 * Connection, read chain state, quote a trade, build a transaction or sign.
 */
export function officialPumpSdkModulesAvailable(): {
  curve: boolean;
  pumpSwap: boolean;
} {
  return {
    curve: typeof OnlinePumpSdk === "function",
    pumpSwap: typeof OnlinePumpAmmSdk === "function"
  };
}
