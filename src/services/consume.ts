import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";

export interface ConsumeInput {
  accountId: number;
  userExternalId: string;
  units: number;
  requestId: string;
}

type Level = "account" | "user";
type Rule = "max_per_request" | "monthly_allowance";

export interface Reason {
  by: Level;
  rule: Rule;
}

export interface LevelStatus {
  used: number;
  remaining: number;
  monthlyAllowance: number;
  maxPerRequest: number;
}

export interface ConsumeResult {
  accepted: boolean;
  replayed: boolean;
  requestId: string;
  units: number;
  month: string;
  reason: Reason | null;
  user: LevelStatus & { externalId: string };
  account: LevelStatus;
}

// Usage is bucketed by UTC calendar month (first day of the month)
function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function status(used: number, monthlyAllowance: number, maxPerRequest: number): LevelStatus {
  // If the allowance was reduced below existing usage, remaining is 0 (never negative)
  return { used, remaining: Math.max(0, monthlyAllowance - used), monthlyAllowance, maxPerRequest };
}

export async function consume(input: ConsumeInput): Promise<ConsumeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await consumeInTransaction(client, input);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function consumeInTransaction(
  client: PoolClient,
  { accountId, userExternalId, units, requestId }: ConsumeInput,
): Promise<ConsumeResult> {
  const month = currentMonth();

  // 1. The user must belong to the calling account
  const userRes = await client.query(
    "SELECT id FROM users WHERE account_id = $1 AND external_id = $2",
    [accountId, userExternalId],
  );
  if (userRes.rows.length === 0) {
    throw new AppError(404, "user_not_found", "User not found");
  }
  const userId: number = userRes.rows[0].id;

  // 2. Make sure this month's counters exist (a new month starts at zero)
  await client.query(
    "INSERT INTO account_usage (account_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [accountId, month],
  );
  await client.query(
    "INSERT INTO user_usage (user_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [userId, month],
  );

  // 3. Lock counters in a fixed order (account, then user) to avoid deadlocks
  const accUsage = await client.query(
    "SELECT used FROM account_usage WHERE account_id = $1 AND month = $2 FOR UPDATE",
    [accountId, month],
  );
  const usrUsage = await client.query(
    "SELECT used FROM user_usage WHERE user_id = $1 AND month = $2 FOR UPDATE",
    [userId, month],
  );
  let accountUsed: number = accUsage.rows[0].used;
  let userUsed: number = usrUsage.rows[0].used;

  // 4. Current limits, read from the DB on every request (plan changes apply immediately)
  const lim = (
    await client.query(
      `SELECT ap.monthly_allowance AS a_month, ap.max_per_request AS a_max,
              up.monthly_allowance AS u_month, up.max_per_request AS u_max
         FROM accounts a
         JOIN plans ap ON ap.id = a.plan_id
         JOIN users u  ON u.id = $2
         JOIN plans up ON up.id = u.plan_id
        WHERE a.id = $1`,
      [accountId, userId],
    )
  ).rows[0];

  const build = (accepted: boolean, replayed: boolean, reason: Reason | null): ConsumeResult => ({
    accepted,
    replayed,
    requestId,
    units,
    month,
    reason,
    user: { externalId: userExternalId, ...status(userUsed, lim.u_month, lim.u_max) },
    account: status(accountUsed, lim.a_month, lim.a_max),
  });

  // 5. Idempotency: the same requestId returns the stored decision and counts nothing again
  const prev = await client.query(
    `SELECT user_id, units, accepted, rejected_by, rejected_rule
       FROM requests WHERE account_id = $1 AND request_id = $2`,
    [accountId, requestId],
  );
  if (prev.rows.length > 0) {
    const p = prev.rows[0];
    if (p.user_id !== userId || p.units !== units) {
      throw new AppError(
        409,
        "idempotency_conflict",
        "This requestId was already used with a different user or units",
      );
    }
    return build(p.accepted, true, p.accepted ? null : { by: p.rejected_by, rule: p.rejected_rule });
  }

  // 6. Evaluate rules in a fixed order; the first violated rule is the reported reason
  let reason: Reason | null = null;
  if (units > lim.u_max) reason = { by: "user", rule: "max_per_request" };
  else if (units > lim.a_max) reason = { by: "account", rule: "max_per_request" };
  else if (units > Math.max(0, lim.u_month - userUsed)) reason = { by: "user", rule: "monthly_allowance" };
  else if (units > Math.max(0, lim.a_month - accountUsed)) reason = { by: "account", rule: "monthly_allowance" };

  // 7. Count usage only if accepted; a rejection consumes nothing
  if (!reason) {
    await client.query(
      "UPDATE account_usage SET used = used + $3 WHERE account_id = $1 AND month = $2",
      [accountId, month, units],
    );
    await client.query(
      "UPDATE user_usage SET used = used + $3 WHERE user_id = $1 AND month = $2",
      [userId, month, units],
    );
    accountUsed += units;
    userUsed += units;
  }

  // 8. Every decision is recorded in the history
  await client.query(
    `INSERT INTO requests (account_id, user_id, request_id, units, accepted, rejected_by, rejected_rule)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [accountId, userId, requestId, units, !reason, reason?.by ?? null, reason?.rule ?? null],
  );

  return build(!reason, false, reason);
}
