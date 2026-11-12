import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = "pumpfun-paper-trader:postgres-migrations";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies ordered SQL migrations once, each in its own transaction.
 * The advisory transaction lock serializes concurrent deploy/start commands.
 * This is an explicit operator command; the application never migrates on boot.
 */
export async function applyDatabaseMigrations(
  databaseUrl = process.env.DATABASE_URL,
  migrationDirectory = path.resolve(process.cwd(), "db/migrations")
): Promise<MigrationResult> {
  if (!databaseUrl?.trim()) throw new Error("DATABASE_URL is required to apply database migrations.");

  const files = (await readdir(migrationDirectory))
    .filter(file => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
  if (files.length === 0 || files.some(file => !MIGRATION_NAME.test(file))) {
    throw new Error("Migration directory must contain ordered files named NNNN_description.sql.");
  }
  const prefixes = files.map(file => file.slice(0, 4));
  if (new Set(prefixes).size !== prefixes.length) {
    throw new Error("Duplicate migration sequence number detected; every SQL migration needs a unique NNNN prefix.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true
  });
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const version = file.slice(0, -4);
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [LOCK_KEY]);
        const existing = await client.query(
          "SELECT 1 FROM schema_migrations WHERE version = $1 LIMIT 1",
          [version]
        );
        if (existing.rowCount) {
          await client.query("COMMIT");
          skipped.push(version);
          continue;
        }

        const sql = await readFile(path.join(migrationDirectory, file), "utf8");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
          [version]
        );
        await client.query("COMMIT");
        applied.push(version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${version} failed; transaction rolled back.`, { cause: error });
      }
    }
    return { applied, skipped };
  } finally {
    client.release();
    await pool.end();
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await applyDatabaseMigrations();
    for (const version of result.applied) process.stdout.write(`APPLIED ${version}\n`);
    for (const version of result.skipped) process.stdout.write(`SKIPPED ${version}\n`);
    if (result.applied.length === 0) process.stdout.write("Database schema is already current.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Database migration failed."}\n`);
    process.exitCode = 1;
  }
}
