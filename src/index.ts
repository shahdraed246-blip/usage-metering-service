import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";

const app = await buildApp();
await runMigrations();

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
