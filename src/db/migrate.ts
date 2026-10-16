import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./pool.js";

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.resolve("migrations");

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // advisory lock: لو في أكتر من نسخة بتشتغل، وحدة بس بتعمل migrate
    await client.query("SELECT pg_advisory_lock(727274)");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name as string));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`migration applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)");
    client.release();
  }
}
