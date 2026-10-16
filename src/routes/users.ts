import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { AppError, parseBody } from "../errors.js";
import { requireApiKey } from "../services/auth.js";

const createUserBody = z.object({
  externalId: z.string().min(1),
  planId: z.number().int().positive().optional(),
});

const updateUserBody = z.object({
  planId: z.number().int().positive(),
});

// A user plan must have scope 'user' and be predefined or owned by this account
async function resolveUserPlan(accountId: number, planId?: number): Promise<number> {
  const { rows } = planId
    ? await pool.query(
        `SELECT id FROM plans WHERE id = $1 AND scope = 'user'
           AND (account_id IS NULL OR account_id = $2)`,
        [planId, accountId],
      )
    : await pool.query("SELECT id FROM plans WHERE name = 'Basic' AND is_predefined");
  if (rows.length === 0) {
    throw new AppError(400, "invalid_plan", "Plan not found or not available to this account");
  }
  return rows[0].id;
}

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  app.post("/users", async (req, reply) => {
    const body = parseBody(createUserBody, req.body);
    const accountId = req.account!.id;
    const planId = await resolveUserPlan(accountId, body.planId);

    try {
      const { rows } = await pool.query(
        `INSERT INTO users (account_id, external_id, plan_id)
         VALUES ($1, $2, $3) RETURNING id, external_id, plan_id`,
        [accountId, body.externalId, planId],
      );
      return reply.code(201).send({
        id: rows[0].id,
        externalId: rows[0].external_id,
        planId: rows[0].plan_id,
      });
    } catch (err: any) {
      if (err.code === "23505") {
        throw new AppError(409, "user_already_exists", "A user with this externalId already exists");
      }
      throw err;
    }
  });

  app.get("/users/:externalId", async (req) => {
    const { externalId } = req.params as { externalId: string };
    const { rows } = await pool.query(
      `SELECT u.id, u.external_id AS "externalId", u.plan_id AS "planId",
              p.name AS "planName", p.monthly_allowance AS "monthlyAllowance",
              p.max_per_request AS "maxPerRequest"
         FROM users u JOIN plans p ON p.id = u.plan_id
        WHERE u.account_id = $1 AND u.external_id = $2`,
      [req.account!.id, externalId],
    );
    if (rows.length === 0) throw new AppError(404, "user_not_found", "User not found");
    return rows[0];
  });

  app.put("/users/:externalId/plan", async (req) => {
    const body = parseBody(updateUserBody, req.body);
    const { externalId } = req.params as { externalId: string };
    const accountId = req.account!.id;
    const planId = await resolveUserPlan(accountId, body.planId);

    const { rows } = await pool.query(
      `UPDATE users SET plan_id = $1
        WHERE account_id = $2 AND external_id = $3
        RETURNING id, external_id AS "externalId", plan_id AS "planId"`,
      [planId, accountId, externalId],
    );
    if (rows.length === 0) throw new AppError(404, "user_not_found", "User not found");
    return rows[0];
  });
}
