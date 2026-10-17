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

export async function consume({
  accountId,
  userExternalId,
  units,
  requestId,
}: ConsumeInput): Promise<ConsumeResult> {
  const month = currentMonth();

  // Outside the lock: resolve the user and make sure this month's counters exist
  // (a new month starts at zero). One round trip, no lock held.
  const setup = await pool.query(
    `WITH u AS (
       SELECT id FROM users WHERE account_id = $1::int AND external_id = $2::text
     ), a AS (
       INSERT INTO account_usage (account_id, month) VALUES ($1::int, $3::date)
       ON CONFLICT DO NOTHING
     ), b AS (
       INSERT INTO user_usage (user_id, month) SELECT id, $3::date FROM u
       ON CONFLICT DO NOTHING
     )
     SELECT id FROM u`,
    [accountId, userExternalId, month],
  );
  if (setup.rows.length === 0) {
    throw new AppError(404, "user_not_found", "User not found");
  }
  const userId: number = setup.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock only the account's counter row. Every request of this account takes this
    //    lock first, so requests of one account run one at a time. That also protects the
    //    user's counter: user_usage is only ever written by consume, after this lock.
    await client.query(
      "SELECT 1 FROM account_usage WHERE account_id = $1 AND month = $2 FOR UPDATE",
      [accountId, month],
    );

    // 2. Read everything in one statement. It starts after the lock was granted, so it
    //    sees the latest committed counters. Limits come from the DB on every request,
    //    so plan changes apply immediately.
    const s = (
      await client.query(
        `SELECT au.used AS a_used, uu.used AS u_used,
                ap.monthly_allowance AS a_month, ap.max_per_request AS a_max,
                up.monthly_allowance AS u_month, up.max_per_request AS u_max,
                r.user_id AS p_user, r.units AS p_units, r.accepted AS p_accepted,
                r.rejected_by AS p_by, r.rejected_rule AS p_rule
           FROM accounts a
           JOIN account_usage au ON au.account_id = a.id AND au.month = $3
           JOIN plans ap ON ap.id = a.plan_id
           JOIN users u ON u.id = $2
           JOIN user_usage uu ON uu.user_id = u.id AND uu.month = $3
           JOIN plans up ON up.id = u.plan_id
           LEFT JOIN requests r ON r.account_id = a.id AND r.request_id = $4
          WHERE a.id = $1`,
        [accountId, userId, month, requestId],
      )
    ).rows[0];

    let accountUsed: number = s.a_used;
    let userUsed: number = s.u_used;

    const build = (accepted: boolean, replayed: boolean, reason: Reason | null): ConsumeResult => ({
      accepted,
      replayed,
      requestId,
      units,
      month,
      reason,
      user: { externalId: userExternalId, ...status(userUsed, s.u_month, s.u_max) },
      account: status(accountUsed, s.a_month, s.a_max),
    });

    // 3. Idempotency: the same requestId returns the stored decision and counts nothing again
    if (s.p_user !== null) {
      if (s.p_user !== userId || s.p_units !== units) {
        throw new AppError(
          409,
          "idempotency_conflict",
          "This requestId was already used with a different user or units",
        );
      }
      await client.query("COMMIT");
      return build(s.p_accepted, true, s.p_accepted ? null : { by: s.p_by, rule: s.p_rule });
    }

    // 4. Evaluate rules in a fixed order; the first violated rule is the reported reason
    let reason: Reason | null = null;
    if (units > s.u_max) reason = { by: "user", rule: "max_per_request" };
    else if (units > s.a_max) reason = { by: "account", rule: "max_per_request" };
    else if (units > Math.max(0, s.u_month - userUsed)) reason = { by: "user", rule: "monthly_allowance" };
    else if (units > Math.max(0, s.a_month - accountUsed)) reason = { by: "account", rule: "monthly_allowance" };

    // 5. One write statement. Usage is counted only if accepted; a rejection consumes nothing.
    //    Every decision is recorded in the history.
    if (!reason) {
      await client.query(
        `WITH a AS (UPDATE account_usage SET used = used + $3 WHERE account_id = $1 AND month = $2),
              u AS (UPDATE user_usage SET used = used + $3 WHERE user_id = $4 AND month = $2)
         INSERT INTO requests (account_id, user_id, request_id, units, accepted)
         VALUES ($1, $4, $5, $3, true)`,
        [accountId, month, units, userId, requestId],
      );
      accountUsed += units;
      userUsed += units;
    } else {
      await client.query(
        `INSERT INTO requests (account_id, user_id, request_id, units, accepted, rejected_by, rejected_rule)
         VALUES ($1, $2, $3, $4, false, $5, $6)`,
        [accountId, userId, requestId, units, reason.by, reason.rule],
      );
    }

    await client.query("COMMIT");
    return build(!reason, false, reason);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
