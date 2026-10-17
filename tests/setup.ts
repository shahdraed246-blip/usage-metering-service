import { afterAll } from "vitest";
import { pool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

// Create the schema and seed predefined plans in the test database (idempotent)
await runMigrations();

afterAll(async () => {
  await pool.end();
});
