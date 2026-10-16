import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { parseBody } from "../errors.js";
import { requireApiKey } from "../services/auth.js";

const requestsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
  userId: z.string().min(1).optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must look like 2026-10")
    .optional(),
});

// UTC [start, end) range for a YYYY-MM month
function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  return [
    new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    new Date(Date.UTC(y, m, 1)).toISOString(),
  ];
}

export async function requestRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  // Request history, newest first. Cursor pagination: pass nextCursor back as ?cursor=
  app.get("/requests", async (req) => {
    const q = parseBody(requestsQuery, req.query);
    const [from, to] = q.month ? monthRange(q.month) : [null, null];

    const { rows } = await pool.query(
      `SELECT r.id, r.request_id AS "requestId", u.external_id AS "userId",
              r.units, r.accepted, r.rejected_by AS "rejectedBy",
              r.rejected_rule AS "rejectedRule", r.created_at AS "createdAt"
         FROM requests r
         JOIN users u ON u.id = r.user_id
        WHERE r.account_id = $1
          AND ($2::text IS NULL OR u.external_id = $2)
          AND ($3::timestamptz IS NULL OR r.created_at >= $3)
          AND ($4::timestamptz IS NULL OR r.created_at < $4)
          AND ($5::bigint IS NULL OR r.id < $5)
        ORDER BY r.id DESC
        LIMIT $6`,
      [req.account!.id, q.userId ?? null, from, to, q.cursor ?? null, q.limit + 1],
    );

    // We fetched one extra row to know whether another page exists
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    return {
      requests: page.map((r) => ({
        id: r.id,
        requestId: r.requestId,
        userId: r.userId,
        units: r.units,
        accepted: r.accepted,
        reason: r.accepted ? null : { by: r.rejectedBy, rule: r.rejectedRule },
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  });
}
