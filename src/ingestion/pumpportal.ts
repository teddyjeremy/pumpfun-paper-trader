export const PUMPPORTAL_DATA_ENDPOINT = "wss://pumpportal.fun/api/data";

export type PumpPortalDiscoveryKind = "new_token" | "migration";

export interface PumpPortalDiscoveryEvent {
  provider: "pumpportal";
  kind: PumpPortalDiscoveryKind;
  mint: string;
  signature: string | null;
  creator: string | null;
  bondingCurve: string | null;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  receivedAt: string;
  raw: Record<string, unknown>;
}

export type PumpPortalParseResult =
  | { status: "EVENT"; event: PumpPortalDiscoveryEvent }
  | { status: "IGNORED"; reason: string }
  | { status: "DATA_INCOMPLETE"; reason: string };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

/**
 * Discovery-only URL. No API key or linked wallet is used.
 * Never add subscribeTokenTrade or subscribeAccountTrade here: those streams
 * are metered by PumpPortal and are outside this free-tier ingestion design.
 */
export function buildPumpPortalDiscoveryUrl(): string {
  return PUMPPORTAL_DATA_ENDPOINT;
}

/** The only PumpPortal methods this project is permitted to subscribe to. */
export function pumpPortalDiscoverySubscriptions(): Array<{ method: string }> {
  return [
    { method: "subscribeNewToken" },
    { method: "subscribeMigration" }
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse a provider message without treating it as verified chain state.
 * The provider does not supply a guaranteed block timestamp in every event;
 * receivedAt is our local receipt time and must not be used as chain time.
 */
export function parsePumpPortalDiscoveryMessage(
  input: unknown,
  receivedAt = new Date().toISOString()
): PumpPortalParseResult {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { status: "DATA_INCOMPLETE", reason: "PumpPortal message is not valid JSON." };
    }
  }
  if (!isRecord(value)) {
    return { status: "DATA_INCOMPLETE", reason: "PumpPortal message is not an object." };
  }

  const txType = value.txType;
  const kind: PumpPortalDiscoveryKind | null =
    txType === "create" ? "new_token" :
    txType === "migrate" ? "migration" : null;

  if (!kind) {
    return { status: "IGNORED", reason: "Message is not a new-token or migration discovery event." };
  }

  const mint = nullableString(value.mint);
  if (!mint || !BASE58.test(mint)) {
    return { status: "DATA_INCOMPLETE", reason: "Discovery event has a missing or invalid mint." };
  }

  const signature = nullableString(value.signature);
  if (signature && !SIGNATURE.test(signature)) {
    return { status: "DATA_INCOMPLETE", reason: "Discovery event has an invalid transaction signature." };
  }

  const creator = nullableString(value.traderPublicKey);
  if (creator && !BASE58.test(creator)) {
    return { status: "DATA_INCOMPLETE", reason: "Discovery event has an invalid creator address." };
  }

  const bondingCurve = nullableString(value.bondingCurveKey);
  if (bondingCurve && !BASE58.test(bondingCurve)) {
    return { status: "DATA_INCOMPLETE", reason: "Discovery event has an invalid bonding-curve address." };
  }

  return {
    status: "EVENT",
    event: {
      provider: "pumpportal",
      kind,
      mint,
      signature,
      creator,
      bondingCurve,
      name: nullableString(value.name),
      symbol: nullableString(value.symbol),
      uri: nullableString(value.uri),
      receivedAt,
      raw: { ...value }
    }
  };
}
