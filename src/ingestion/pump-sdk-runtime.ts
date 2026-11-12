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
  return Boolean(value && (typeof value === "object" || typeof value === "function") &&
    typeof (value as SdkObject)[method] === "function");
}

function methodNames(value: unknown): string[] {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
  const names = new Set<string>(Object.keys(value));
  let prototype = Object.getPrototypeOf(value) as object | null;
  while (prototype && prototype !== Object.prototype && prototype !== Function.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== "constructor") names.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return [...names].sort();
}

function hasAnyMethod(objects: readonly unknown[], methods: readonly string[]): boolean {
  return methods.some(method => objects.some(value => hasMethod(value, method)));
}

export interface PumpSdkInstructionCapabilities {
  curveV3: { buy: boolean; sell: boolean };
  curveV2: { buy: boolean; sell: boolean };
  pumpSwapV2: { buy: boolean; sell: boolean };
}

/** Runtime surface inspection only; this never builds or submits a transaction. */
export function officialPumpSdkInstructionCapabilities(): PumpSdkInstructionCapabilities {
  return {
    curveV3: {
      buy: hasAnyMethod([PUMP_SDK, OnlinePumpSdk.prototype], [
        "getBuyV3InstructionRaw", "getBuyExactQuoteInV3InstructionRaw"
      ]),
      sell: hasAnyMethod([PUMP_SDK, OnlinePumpSdk.prototype], ["getSellV3InstructionRaw"])
    },
    curveV2: {
      buy: hasAnyMethod([PUMP_SDK, OnlinePumpSdk.prototype], [
        "getBuyV2InstructionRaw", "getBuyExactQuoteInV2InstructionRaw"
      ]),
      sell: hasAnyMethod([PUMP_SDK, OnlinePumpSdk.prototype], ["getSellV2InstructionRaw"])
    },
    pumpSwapV2: {
      buy: hasAnyMethod([PUMP_AMM_SDK, OnlinePumpAmmSdk.prototype], [
        "buyV2Instructions", "buyExactQuoteInV2Instructions"
      ]),
      sell: hasAnyMethod([PUMP_AMM_SDK, OnlinePumpAmmSdk.prototype], [
        "sellV2Instructions"
      ])
    }
  };
}

/** Export method names so tests can record the pinned SDK's real runtime surface. */
export function officialPumpSdkMethodSurface(): {
  curveStatic: string[];
  curveOnline: string[];
  pumpSwapStatic: string[];
  pumpSwapOnline: string[];
} {
  return {
    curveStatic: methodNames(PUMP_SDK),
    curveOnline: methodNames(OnlinePumpSdk.prototype),
    pumpSwapStatic: methodNames(PUMP_AMM_SDK),
    pumpSwapOnline: methodNames(OnlinePumpAmmSdk.prototype)
  };
}

/**
 * Verifies offline pricing and account-decoding APIs are bundled. Builder
 * capabilities are reported separately because the pinned package exposes
 * these instruction builders on its static SDK objects.
 */
export function officialPumpSdkModulesAvailable(): { curve: boolean; pumpSwap: boolean } {
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
