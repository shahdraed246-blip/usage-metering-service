import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { AppError, parseBody } from "../errors.js";
import { generateApiKey, hashApiKey, requireApiKey } from "../services/auth.js";

const createAccountBody = z.object({
  name: z.string().min(1),
  planId: z.number().int().positive().optional(),
});

const updateAccountPlanBody = z.object({
  planId: z.number().int().positive(),
});

export async function accountRoutes(app: FastifyInstance) {
  // Public: creates an account and returns its API key (shown only once)
  app.post("/accounts", async (req, reply) => {
    const { name, planId } = parseBody(createAccountBody, req.body);

    const plan = planId
      ? await pool.query(
          "SELECT id FROM plans WHERE id = $1 AND scope = 'account' AND account_id IS NULL",
          [planId],
        )
      : await pool.query("SELECT id FROM plans WHERE name = 'Starter' AND is_predefined");
    if (plan.rows.length === 0) {
      throw new AppError(400, "invalid_plan", "Plan not found or not an account plan");
    }

    const apiKey = generateApiKey();
    const { rows } = await pool.query(
      `INSERT INTO accounts (name, api_key_hash, plan_id)
       VALUES ($1, $2, $3) RETURNING id, name, plan_id`,
      [name, hashApiKey(apiKey), plan.rows[0].id],
    );
    return reply.code(201).send({
      id: rows[0].id,
      name: rows[0].name,
      planId: rows[0].plan_id,
      apiKey,
    });
  });

  // The calling account and its current plan
  app.get("/account", { preHandler: requireApiKey }, async (req) => {
    const { rows } = await pool.query(
      `SELECT a.id, a.name, p.id AS "planId", p.name AS "planName",
              p.monthly_allowance AS "monthlyAllowance",
              p.max_per_request AS "maxPerRequest"
         FROM accounts a JOIN plans p ON p.id = a.plan_id
        WHERE a.id = $1`,
      [req.account!.id],
    );
    return rows[0];
  });

  // Switch the account plan (predefined or one of its own account-scope plans)
  app.put("/account/plan", { preHandler: requireApiKey }, async (req) => {
    const { planId } = parseBody(updateAccountPlanBody, req.body);
    const accountId = req.account!.id;
    const plan = await pool.query(
      `SELECT id FROM plans WHERE id = $1 AND scope = 'account'
         AND (account_id IS NULL OR account_id = $2)`,
      [planId, accountId],
    );
    if (plan.rows.length === 0) {
      throw new AppError(400, "invalid_plan", "Plan not found or not an account plan");
    }
    await pool.query("UPDATE accounts SET plan_id = $1 WHERE id = $2", [planId, accountId]);
    return { id: accountId, planId };
  });
}
