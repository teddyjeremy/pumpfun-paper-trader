import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDatabaseMigrations } from "../src/db/migrate.js";

const directories: string[] = [];
async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paper-migrations-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("PostgreSQL migration runner safety", () => {
  it("defines a separate durable Helius gap archive and permits its transaction source", async () => {
    const migration = await readFile(
      new URL("../db/migrations/0009_helius_gap_recovery_archive.sql", import.meta.url),
      "utf8"
    );
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS helius_gap_recovery_jobs");
    expect(migration).toContain("PRIMARY KEY (session_id,mint,started_at)");
    expect(migration).toContain("decode_cursor <= jsonb_array_length(signature_state)");
    expect(migration).toContain("'GAP_RECOVERY'");
    expect(migration).toContain("0009_helius_gap_recovery_archive");
  });

  it("requires an explicit database URL", async () => {
    await expect(applyDatabaseMigrations("")).rejects.toThrow(/DATABASE_URL is required/);
  });

  it("rejects migration files without an ordered four-digit prefix", async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, "initial.sql"), "SELECT 1;");
    await expect(applyDatabaseMigrations("postgres://unused", directory))
      .rejects.toThrow(/NNNN_description/);
  });

  it("rejects duplicate migration sequence numbers before opening a database connection", async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, "0002_positions.sql"), "SELECT 1;");
    await writeFile(path.join(directory, "0002_exits.sql"), "SELECT 1;");
    await expect(applyDatabaseMigrations("postgres://unused", directory))
      .rejects.toThrow(/Duplicate migration sequence/);
  });
});
