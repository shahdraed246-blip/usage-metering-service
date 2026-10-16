import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { AppError, parseBody } from "../errors.js";
import { generateApiKey, hashApiKey } from "../services/auth.js";

const createAccountBody = z.object({
  name: z.string().min(1),
  planId: z.number().int().positive().optional(),
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
}
