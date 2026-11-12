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

type SdkObject = Record<string, unknown>;

function hasMethod(value: unknown, method: string): boolean {
  return Boolean(value && typeof value === "object" &&
    typeof (value as SdkObject)[method] === "function");
}

function hasAnyMethod(objects: readonly unknown[], methods: readonly string[]): boolean {
  return methods.some(method => objects.some(value => hasMethod(value, method)));
}

export interface PumpSdkInstructionCapabilities {
  curveV3: {
    buy: boolean;
    sell: boolean;
  };
  curveV2: {
    buy: boolean;
    sell: boolean;
  };
  pumpSwapV2: {
    buy: boolean;
    sell: boolean;
  };
}

/**
 * Detects the exact raw instruction-builder methods exposed by the pinned
 * SDK bundle. Capability detection is deliberately separate from execution
 * authorization: the presence of a builder does not prove account state,
 * signer availability, fee evidence, or sellability.
 */
export function officialPumpSdkInstructionCapabilities(): PumpSdkInstructionCapabilities {
  return {
    curveV3: {
      buy: hasMethod(PUMP_SDK, "getBuyV3InstructionRaw") ||
        hasMethod(PUMP_SDK, "getBuyExactQuoteInV3InstructionRaw"),
      sell: hasMethod(PUMP_SDK, "getSellV3InstructionRaw")
    },
    curveV2: {
      buy: hasMethod(PUMP_SDK, "getBuyV2InstructionRaw") ||
        hasMethod(PUMP_SDK, "getBuyExactQuoteInV2InstructionRaw"),
      sell: hasMethod(PUMP_SDK, "getSellV2InstructionRaw")
    },
    pumpSwapV2: {
      buy: hasAnyMethod([PUMP_SDK, PUMP_AMM_SDK], [
        "ammBuyV2Instruction", "ammBuyExactQuoteInV2Instruction",
        "buyV2Instruction", "buyExactQuoteInV2Instruction"
      ]),
      sell: hasAnyMethod([PUMP_SDK, PUMP_AMM_SDK], [
        "ammSellV2Instruction", "sellV2Instruction"
      ])
    }
  };
}

/**
 * Verifies the offline pricing, account-decoding and instruction-builder APIs
 * are bundled. This does not create a Connection, read chain state, build a
 * transaction, sign, simulate, or submit.
 */
export function officialPumpSdkModulesAvailable(): {
  curve: boolean;
  pumpSwap: boolean;
} {
  const capabilities = officialPumpSdkInstructionCapabilities();
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
      typeof computeFeesBps === "function" &&
      capabilities.curveV3.buy && capabilities.curveV3.sell &&
      capabilities.curveV2.buy && capabilities.curveV2.sell,
    pumpSwap: typeof OnlinePumpAmmSdk === "function" &&
      typeof PUMP_AMM_SDK === "object" &&
      typeof buyQuoteInput === "function" &&
      typeof sellBaseInput === "function" &&
      capabilities.pumpSwapV2.buy && capabilities.pumpSwapV2.sell
  };
}
