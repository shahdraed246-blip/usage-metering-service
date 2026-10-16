import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { AppError, parseBody } from "../errors.js";
import { requireApiKey } from "../services/auth.js";

const createPlanBody = z.object({
  scope: z.enum(["account", "user"]),
  name: z.string().min(1),
  monthlyAllowance: z.number().int().min(0),
  maxPerRequest: z.number().int().min(1),
});

const updatePlanBody = z
  .object({
    name: z.string().min(1),
    monthlyAllowance: z.number().int().min(0),
    maxPerRequest: z.number().int().min(1),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: "at least one field is required" });

const COLUMNS = `id, scope, name,
  monthly_allowance AS "monthlyAllowance",
  max_per_request AS "maxPerRequest",
  is_predefined AS "isPredefined"`;

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(404, "plan_not_found", "Plan not found");
  }
  return id;
}

// A plan is visible if it is predefined or owned by the calling account
async function findVisiblePlan(accountId: number, id: number) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM plans
      WHERE id = $1 AND (account_id IS NULL OR account_id = $2)`,
    [id, accountId],
  );
  if (rows.length === 0) throw new AppError(404, "plan_not_found", "Plan not found");
  return rows[0];
}

export async function planRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  app.post("/plans", async (req, reply) => {
    const body = parseBody(createPlanBody, req.body);
    const { rows } = await pool.query(
      `INSERT INTO plans (account_id, scope, name, monthly_allowance, max_per_request)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [req.account!.id, body.scope, body.name, body.monthlyAllowance, body.maxPerRequest],
    );
    return reply.code(201).send(rows[0]);
  });

  app.get("/plans", async (req) => {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM plans
        WHERE account_id IS NULL OR account_id = $1 ORDER BY id`,
      [req.account!.id],
    );
    return { plans: rows };
  });

  app.get("/plans/:id", async (req) => {
    const { id } = req.params as { id: string };
    return findVisiblePlan(req.account!.id, parseId(id));
  });

  app.put("/plans/:id", async (req) => {
    const body = parseBody(updatePlanBody, req.body);
    const { id } = req.params as { id: string };
    const planId = parseId(id);
    const existing = await findVisiblePlan(req.account!.id, planId);
    if (existing.isPredefined) {
      throw new AppError(403, "plan_read_only", "Predefined plans cannot be modified");
    }
    const { rows } = await pool.query(
      `UPDATE plans SET
         name = COALESCE($1, name),
         monthly_allowance = COALESCE($2, monthly_allowance),
         max_per_request = COALESCE($3, max_per_request)
       WHERE id = $4 AND account_id = $5
       RETURNING ${COLUMNS}`,
      [body.name ?? null, body.monthlyAllowance ?? null, body.maxPerRequest ?? null,
       planId, req.account!.id],
    );
    return rows[0];
  });
}
