import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
