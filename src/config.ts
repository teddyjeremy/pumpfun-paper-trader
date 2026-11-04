import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().optional().default(""),
  HELIUS_API_KEY: z.string().optional().default(""),
  PUMPFUN_MODE: z.literal("paper").default("paper"),
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(8),
  PAPER_POSITION_SIZE_USD: z.coerce.number().positive().default(1),
  PAPER_MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(3).default(3),
  PAPER_MAX_HOLD_SECONDS: z.coerce.number().int().positive().max(60).default(60),
  DIAGNOSTICS_RETENTION_HOURS: z.coerce.number().int().positive().default(24)
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}
if (parsed.data.PAPER_POSITION_SIZE_USD * parsed.data.PAPER_MAX_OPEN_POSITIONS > parsed.data.PAPER_STARTING_BALANCE_USD) {
  throw new Error("Maximum position allocation cannot exceed the paper starting balance.");
}

export const config = Object.freeze(parsed.data);
