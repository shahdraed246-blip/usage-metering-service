import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { api, createAccount, createApp, type App } from "./helpers.js";

let app: App;
type Client = ReturnType<typeof api>;

beforeAll(async () => {
  app = await createApp();
});

afterAll(async () => {
  await app.close();
});

// Default plans: account Starter (10000 / 100), user Basic (1000 / 20)
async function makeAccount(accountLimits?: { monthlyAllowance: number; maxPerRequest: number }) {
  const acc = await createAccount(app, "c-" + Math.random().toString(36).slice(2));
  const client = api(app, acc.apiKey);
  if (accountLimits) {
    const plan = (await client.post("/plans", { scope: "account", name: "acct", ...accountLimits })).json();
    await client.put("/account/plan", { planId: plan.id });
  }
  return { client, accountId: acc.id };
}

async function makeUser(
  client: Client,
  externalId: string,
  limits?: { monthlyAllowance: number; maxPerRequest: number },
) {
  let planId: number | undefined;
  if (limits) {
    planId = (await client.post("/plans", { scope: "user", name: "u-" + externalId, ...limits })).json().id;
  }
  await client.post("/users", { externalId, planId });
  return planId;
}

async function consume(client: Client, userId: string, units: number, requestId: string) {
  return (await client.post("/consume", { userId, units, requestId })).json();
}

describe("rules", () => {
  it("accepts a request and counts it on both the user and the account", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    const r = await consume(client, "alice", 10, "r1");
    expect(r.accepted).toBe(true);
    expect(r.user).toMatchObject({ used: 10, remaining: 990 });
    expect(r.account).toMatchObject({ used: 10, remaining: 9990 });
  });

  it("rejects by the user's per-request limit even when allowances are plentiful", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    const r = await consume(client, "alice", 25, "r1");
    expect(r.accepted).toBe(false);
    expect(r.reason).toEqual({ by: "user", rule: "max_per_request" });
    expect(r.user.used).toBe(0);
    expect(r.account.used).toBe(0);
  });

  it("rejects by the account's per-request limit", async () => {
    const { client } = await makeAccount({ monthlyAllowance: 10000, maxPerRequest: 5 });
    await makeUser(client, "alice", { monthlyAllowance: 1000, maxPerRequest: 200 });
    const r = await consume(client, "alice", 10, "r1");
    expect(r.reason).toEqual({ by: "account", rule: "max_per_request" });
  });

  it("rejects by the user's monthly allowance", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice", { monthlyAllowance: 10, maxPerRequest: 10 });
    expect((await consume(client, "alice", 10, "r1")).accepted).toBe(true);
    const r = await consume(client, "alice", 1, "r2");
    expect(r.reason).toEqual({ by: "user", rule: "monthly_allowance" });
    expect(r.user).toMatchObject({ used: 10, remaining: 0 });
  });

  it("rejects by the shared account allowance even if the user has plenty left", async () => {
    const { client } = await makeAccount({ monthlyAllowance: 15, maxPerRequest: 100 });
    await makeUser(client, "alice"); // Basic: 1000 / 20
    expect((await consume(client, "alice", 10, "r1")).accepted).toBe(true);
    const r = await consume(client, "alice", 10, "r2");
    expect(r.accepted).toBe(false);
    expect(r.reason).toEqual({ by: "account", rule: "monthly_allowance" });
    expect(r.account.remaining).toBe(5);
    expect(r.user.remaining).toBe(990);
  });

  it("keeps separate usage for users that share a plan, and sums them at account level", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    await makeUser(client, "bob");
    await consume(client, "alice", 20, "a1");
    const r = await consume(client, "bob", 5, "b1");
    expect(r.user.used).toBe(5);
    expect(r.account.used).toBe(25);
  });

  it("returns 404 for an unknown user and records nothing", async () => {
    const { client } = await makeAccount();
    const res = await client.post("/consume", { userId: "ghost", units: 1, requestId: "r1" });
    expect(res.statusCode).toBe(404);
    expect((await client.get("/requests")).json().requests).toEqual([]);
  });

  it("validates units and required fields", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    for (const units of [0, -5, 1.5, "10", null]) {
      const res = await client.post("/consume", { userId: "alice", units, requestId: "v" });
      expect(res.statusCode, `units=${units}`).toBe(400);
    }
    expect((await client.post("/consume", { userId: "alice", units: 1 })).statusCode).toBe(400);
  });
});

describe("idempotency", () => {
  it("replays an accepted request without counting it twice", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    await consume(client, "alice", 10, "r1");
    const again = await consume(client, "alice", 10, "r1");
    expect(again.replayed).toBe(true);
    expect(again.accepted).toBe(true);
    expect(again.user.used).toBe(10);
    expect(again.account.used).toBe(10);
  });

  it("replays a rejection with the same reason", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    await consume(client, "alice", 25, "r1");
    const again = await consume(client, "alice", 25, "r1");
    expect(again.replayed).toBe(true);
    expect(again.accepted).toBe(false);
    expect(again.reason).toEqual({ by: "user", rule: "max_per_request" });
  });

  it("returns 409 when a requestId is reused with different units", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    await consume(client, "alice", 10, "r1");
    const res = await client.post("/consume", { userId: "alice", units: 5, requestId: "r1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("idempotency_conflict");
  });

  it("allows the same requestId in different accounts", async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    await makeUser(a.client, "alice");
    await makeUser(b.client, "alice");
    expect((await consume(a.client, "alice", 5, "same")).replayed).toBe(false);
    expect((await consume(b.client, "alice", 5, "same")).replayed).toBe(false);
  });
});

describe("plan changes", () => {
  it("applies an updated custom plan to the next request, preserving usage", async () => {
    const { client } = await makeAccount();
    const planId = await makeUser(client, "alice", { monthlyAllowance: 10, maxPerRequest: 10 });
    expect((await consume(client, "alice", 10, "r1")).accepted).toBe(true);
    expect((await consume(client, "alice", 5, "r2")).accepted).toBe(false);

    await client.put(`/plans/${planId}`, { monthlyAllowance: 30 });
    const r = await consume(client, "alice", 10, "r3");
    expect(r.accepted).toBe(true);
    expect(r.user).toMatchObject({ used: 20, remaining: 10 });
  });

  it("shows zero remaining and keeps rejecting when the allowance drops below usage", async () => {
    const { client } = await makeAccount();
    const planId = await makeUser(client, "alice", { monthlyAllowance: 50, maxPerRequest: 10 });
    await consume(client, "alice", 10, "r1");
    await client.put(`/plans/${planId}`, { monthlyAllowance: 5 });
    const r = await consume(client, "alice", 1, "r2");
    expect(r.accepted).toBe(false);
    expect(r.user).toMatchObject({ used: 10, remaining: 0 });
  });

  it("does not grant a fresh allowance when a user switches plans", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice"); // Basic
    await consume(client, "alice", 20, "r1");
    await client.put("/users/alice/plan", { planId: 4 }); // Premium
    const r = await consume(client, "alice", 10, "r2");
    expect(r.user).toMatchObject({ used: 30, monthlyAllowance: 10000 });
  });

  it("applies a new account plan immediately", async () => {
    const { client } = await makeAccount({ monthlyAllowance: 10, maxPerRequest: 10 });
    await makeUser(client, "alice");
    await consume(client, "alice", 10, "r1");
    expect((await consume(client, "alice", 1, "r2")).reason).toEqual({
      by: "account",
      rule: "monthly_allowance",
    });
    await client.put("/account/plan", { planId: 2 }); // Pro
    expect((await consume(client, "alice", 1, "r3")).accepted).toBe(true);
  });

  it("keeps request history after plan changes", async () => {
    const { client } = await makeAccount();
    const planId = await makeUser(client, "alice", { monthlyAllowance: 10, maxPerRequest: 10 });
    await consume(client, "alice", 10, "r1");
    await client.put(`/plans/${planId}`, { monthlyAllowance: 100 });
    const history = (await client.get("/requests")).json().requests;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ requestId: "r1", accepted: true });
  });
});

describe("months, usage and history", () => {
  it("keeps previous months queryable and starts the current month at its own count", async () => {
    const { client, accountId } = await makeAccount();
    await makeUser(client, "alice");
    await pool.query(
      "INSERT INTO account_usage (account_id, month, used) VALUES ($1, '2026-01-01', 40)",
      [accountId],
    );
    await consume(client, "alice", 5, "r1");

    const jan = (await client.get("/usage?month=2026-01")).json();
    expect(jan.account.used).toBe(40);
    const now = (await client.get("/usage")).json();
    expect(now.account.used).toBe(5);
  });

  it("lists rejected requests in history with their reason, and paginates", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    for (let i = 1; i <= 4; i++) await consume(client, "alice", 1, `h-${i}`);
    await consume(client, "alice", 25, "h-big");

    const page1 = (await client.get("/requests?limit=2")).json();
    expect(page1.requests.map((r: any) => r.requestId)).toEqual(["h-big", "h-4"]);
    expect(page1.requests[0].reason).toEqual({ by: "user", rule: "max_per_request" });
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await client.get(`/requests?limit=10&cursor=${page1.nextCursor}`)).json();
    expect(page2.requests.map((r: any) => r.requestId)).toEqual(["h-3", "h-2", "h-1"]);
    expect(page2.nextCursor).toBeNull();
  });
});

describe("concurrency", () => {
  it("never lets parallel requests exceed a user's allowance", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "dave", { monthlyAllowance: 20, maxPerRequest: 20 });

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => consume(client, "dave", 1, `c-${i}`)),
    );
    expect(results.filter((r) => r.accepted)).toHaveLength(20);
    expect(results.filter((r) => !r.accepted)).toHaveLength(10);

    const usage = (await client.get("/usage")).json();
    expect(usage.users[0].used).toBe(20);
    expect(usage.account.used).toBe(20);
  });

  it("never lets parallel requests from several users exceed the shared account allowance", async () => {
    const { client } = await makeAccount({ monthlyAllowance: 25, maxPerRequest: 100 });
    for (const u of ["u1", "u2", "u3"]) {
      await makeUser(client, u, { monthlyAllowance: 100, maxPerRequest: 100 });
    }
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => consume(client, `u${(i % 3) + 1}`, 1, `s-${i}`)),
    );
    expect(results.filter((r) => r.accepted)).toHaveLength(25);
    const rejected = results.filter((r) => !r.accepted);
    expect(rejected.every((r) => r.reason.by === "account")).toBe(true);

    const usage = (await client.get("/usage")).json();
    const sumUsers = usage.users.reduce((s: number, u: any) => s + u.used, 0);
    expect(usage.account.used).toBe(25);
    expect(sumUsers).toBe(25);
  });

  it("counts a retried request only once when the same requestId arrives in parallel", async () => {
    const { client } = await makeAccount();
    await makeUser(client, "alice");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consume(client, "alice", 5, "dup")),
    );
    expect(results.every((r) => r.accepted)).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const usage = (await client.get("/usage")).json();
    expect(usage.users[0].used).toBe(5);
    expect(usage.account.used).toBe(5);
  });
});
