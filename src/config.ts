import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DASHBOARD_USERNAME: z.string().optional().default(""),
  DASHBOARD_PASSWORD: z.string().optional().default(""),
  DATABASE_URL: z.string().optional().default(""),
  PAPER_EVENT_INGEST_TOKEN: z.string().optional().default(""),
  PAPER_WORKER_URL: z.string().optional().default(""),
  PAPER_WORKER_CONTROL_TOKEN: z.string().optional().default(""),
  HELIUS_API_KEY: z.string().optional().default(""),
  PUMPFUN_MODE: z.literal("paper").default("paper"),
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(2.7),
  PAPER_POSITION_SIZE_USD: z.coerce.number().positive().default(1),
  PAPER_MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(3).default(1),
  DYNAMIC_EXIT_ENABLED: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
  DYNAMIC_EXIT_CONFIRMATION_WINDOWS: z.coerce.number().int().min(2).max(5).default(2),
  DYNAMIC_EXIT_MIN_BEARISH_SIGNALS: z.coerce.number().int().min(2).max(7).default(2),
  DYNAMIC_EXIT_BUY_SELL_RATIO_BELOW: z.coerce.number().positive().default(1),
  DYNAMIC_EXIT_BUY_VOLUME_DECLINE_PCT: z.coerce.number().positive().max(100).default(40),
  DYNAMIC_EXIT_BUYER_RATE_DECLINE_PCT: z.coerce.number().positive().max(100).default(40),
  DYNAMIC_EXIT_SELL_VOLUME_EXPANSION_PCT: z.coerce.number().positive().default(50),
  DYNAMIC_EXIT_PRICE_RESPONSE_DECLINE_PCT: z.coerce.number().positive().max(100).default(40),
  DYNAMIC_EXIT_LIQUIDITY_DROP_PCT: z.coerce.number().positive().max(100).default(20),
  DIAGNOSTICS_RETENTION_HOURS: z.coerce.number().int().positive().default(24)
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}
if (Boolean(parsed.data.DASHBOARD_USERNAME) !== Boolean(parsed.data.DASHBOARD_PASSWORD)) {
  throw new Error("DASHBOARD_USERNAME and DASHBOARD_PASSWORD must both be configured.");
}
if (parsed.data.PAPER_WORKER_CONTROL_TOKEN && !parsed.data.PAPER_WORKER_URL) {
  throw new Error("PAPER_WORKER_URL is required when PAPER_WORKER_CONTROL_TOKEN is configured.");
}
if (parsed.data.PAPER_WORKER_URL) {
  let workerUrl: URL;
  try { workerUrl = new URL(parsed.data.PAPER_WORKER_URL); }
  catch { throw new Error("PAPER_WORKER_URL must be a valid absolute URL."); }
  if (workerUrl.protocol !== "https:" && workerUrl.protocol !== "http:") {
    throw new Error("PAPER_WORKER_URL must use HTTP or HTTPS.");
  }
  if (parsed.data.NODE_ENV === "production" && workerUrl.protocol !== "https:") {
    throw new Error("PAPER_WORKER_URL must use HTTPS in production.");
  }
}
if (parsed.data.DASHBOARD_USERNAME.includes(":")) {
  throw new Error("DASHBOARD_USERNAME cannot contain a colon when using HTTP Basic authentication.");
}
if (parsed.data.PAPER_POSITION_SIZE_USD * parsed.data.PAPER_MAX_OPEN_POSITIONS > parsed.data.PAPER_STARTING_BALANCE_USD) {
  throw new Error("Maximum position allocation cannot exceed the paper starting balance.");
}

export const config = Object.freeze(parsed.data);

/** Paper calibration profile; callers must persist these values with each exit decision. */
export const dynamicExitConfig = Object.freeze({
  enabled: config.DYNAMIC_EXIT_ENABLED,
  confirmationWindows: config.DYNAMIC_EXIT_CONFIRMATION_WINDOWS,
  minBearishSignalsPerWindow: config.DYNAMIC_EXIT_MIN_BEARISH_SIGNALS,
  buySellRatioBelow: config.DYNAMIC_EXIT_BUY_SELL_RATIO_BELOW,
  buyVolumeDeclinePct: config.DYNAMIC_EXIT_BUY_VOLUME_DECLINE_PCT,
  buyerRateDeclinePct: config.DYNAMIC_EXIT_BUYER_RATE_DECLINE_PCT,
  sellVolumeExpansionPct: config.DYNAMIC_EXIT_SELL_VOLUME_EXPANSION_PCT,
  priceResponseDeclinePct: config.DYNAMIC_EXIT_PRICE_RESPONSE_DECLINE_PCT,
  liquidityDropPct: config.DYNAMIC_EXIT_LIQUIDITY_DROP_PCT
});
