import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().optional().default(""),
  HELIUS_API_KEY: z.string().optional().default(""),
  PUMPFUN_MODE: z.literal("paper").default("paper"),
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(2.7),
  PAPER_POSITION_SIZE_USD: z.coerce.number().positive().default(1),
  PAPER_FIRST_CAPACITY_THRESHOLD_USD: z.coerce.number().positive().default(5),
  PAPER_MAX_POSITION_SIZE_USD: z.coerce.number().positive().default(100),
  PAPER_HARD_MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(50).default(50),
  EXIT_BUY_SELL_RATIO_MAX: z.coerce.number().positive().default(1.2),
  EXIT_BUY_VOLUME_DECLINE_PCT_MIN: z.coerce.number().min(0).max(100).default(40),
  EXIT_BUYER_RATE_DECLINE_PCT_MIN: z.coerce.number().min(0).max(100).default(40),
  EXIT_LIQUIDITY_DECLINE_PCT_MIN: z.coerce.number().min(0).max(100).default(20),
  EXIT_CONFIRMATION_WINDOWS: z.coerce.number().int().min(1).max(3).default(2),
  EXIT_MIN_BEARISH_SIGNALS_PER_WINDOW: z.coerce.number().int().min(1).max(5).default(2),
  DIAGNOSTICS_RETENTION_HOURS: z.coerce.number().int().positive().default(24)
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}
if (parsed.data.PAPER_POSITION_SIZE_USD > parsed.data.PAPER_STARTING_BALANCE_USD) {
  throw new Error("Initial position principal cannot exceed the paper starting balance.");
}
if (parsed.data.PAPER_MAX_POSITION_SIZE_USD < parsed.data.PAPER_POSITION_SIZE_USD) {
  throw new Error("Maximum position size cannot be below the initial position size.");
}

export const config = Object.freeze(parsed.data);
