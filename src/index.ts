import Fastify from "fastify";
import { pool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok" };
});

await runMigrations();

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
