import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";

export function generateApiKey(): string {
  return "sk_" + randomBytes(24).toString("hex");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface AuthedAccount {
  id: number;
  name: string;
  planId: number;
}

declare module "fastify" {
  interface FastifyRequest {
    account?: AuthedAccount;
  }
}

export async function requireApiKey(req: FastifyRequest): Promise<void> {
  const key = req.headers["x-api-key"];
  if (typeof key !== "string" || key.length === 0) {
    throw new AppError(401, "missing_api_key", "x-api-key header is required");
  }
  const { rows } = await pool.query(
    "SELECT id, name, plan_id FROM accounts WHERE api_key_hash = $1",
    [hashApiKey(key)],
  );
  if (rows.length === 0) {
    throw new AppError(401, "invalid_api_key", "API key is invalid");
  }
  req.account = { id: rows[0].id, name: rows[0].name, planId: rows[0].plan_id };
}
