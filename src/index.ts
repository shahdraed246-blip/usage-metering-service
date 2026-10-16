import Fastify from "fastify";
import { pool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { AppError } from "./errors.js";
import { accountRoutes } from "./routes/accounts.js";
import { userRoutes } from "./routes/users.js";
import { planRoutes } from "./routes/plans.js";
import { consumeRoutes } from "./routes/consume.js";
import { usageRoutes } from "./routes/usage.js";
import { requestRoutes } from "./routes/requests.js";
const app = Fastify({ logger: true });

// One consistent error shape: { error: { code, message, details? } }
app.setErrorHandler((err, req, reply) => {
  if (err instanceof AppError) {
    return reply.code(err.status).send({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  if (err.statusCode && err.statusCode < 500) {
    return reply
      .code(err.statusCode)
      .send({ error: { code: "bad_request", message: err.message } });
  }
  req.log.error(err);
  return reply
    .code(500)
    .send({ error: { code: "internal_error", message: "Unexpected error" } });
});

app.setNotFoundHandler((_req, reply) =>
  reply.code(404).send({ error: { code: "route_not_found", message: "Route not found" } }),
);

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok" };
});

await app.register(accountRoutes);
await app.register(userRoutes);
await app.register(planRoutes);
await app.register(consumeRoutes);
await app.register(usageRoutes);
await app.register(requestRoutes);
await runMigrations();

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
