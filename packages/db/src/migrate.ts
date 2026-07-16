import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabasePool } from "./pool.js";

const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export async function migrate(pool: DatabasePool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  const files = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const exists = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1) AS exists",
      [file],
    );
    if (exists.rows[0]?.exists) continue;
    const sql = await readFile(join(migrationDirectory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [
        file,
      ]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return applied;
}
