import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { parseBody } from "../errors.js";
import { requireApiKey } from "../services/auth.js";

const usageQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must look like 2026-10")
    .optional(),
});

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// remaining is never negative, even if the allowance was lowered below usage
function level(used: number, monthlyAllowance: number, maxPerRequest: number) {
  return { used, remaining: Math.max(0, monthlyAllowance - used), monthlyAllowance, maxPerRequest };
}

export async function usageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  // Usage for one UTC month. Remaining is computed against the plans applied today.
  app.get("/usage", async (req) => {
    const { month = currentMonth() } = parseBody(usageQuery, req.query);
    const monthStart = `${month}-01`;
    const accountId = req.account!.id;

    const acc = (
      await pool.query(
        `SELECT p.id AS "planId", p.name AS "planName",
                p.monthly_allowance AS "monthlyAllowance",
                p.max_per_request AS "maxPerRequest",
                COALESCE(au.used, 0) AS used
           FROM accounts a
           JOIN plans p ON p.id = a.plan_id
           LEFT JOIN account_usage au ON au.account_id = a.id AND au.month = $2
          WHERE a.id = $1`,
        [accountId, monthStart],
      )
    ).rows[0];

    const users = (
      await pool.query(
        `SELECT u.external_id AS "externalId", p.id AS "planId", p.name AS "planName",
                p.monthly_allowance AS "monthlyAllowance",
                p.max_per_request AS "maxPerRequest",
                COALESCE(uu.used, 0) AS used
           FROM users u
           JOIN plans p ON p.id = u.plan_id
           LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.month = $2
          WHERE u.account_id = $1
          ORDER BY u.id`,
        [accountId, monthStart],
      )
    ).rows;

    return {
      month,
      account: {
        plan: { id: acc.planId, name: acc.planName },
        ...level(acc.used, acc.monthlyAllowance, acc.maxPerRequest),
      },
      users: users.map((u) => ({
        externalId: u.externalId,
        plan: { id: u.planId, name: u.planName },
        ...level(u.used, u.monthlyAllowance, u.maxPerRequest),
      })),
    };
  });
}
