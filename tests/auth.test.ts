import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { api, createAccount, createApp, type App } from "./helpers.js";

let app: App;

beforeAll(async () => {
  app = await createApp();
});

afterAll(async () => {
  await app.close();
});

describe("API key validation", () => {
  it("rejects a request without a key", async () => {
    const res = await app.inject({ method: "GET", url: "/users/alice" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("missing_api_key");
  });

  it("rejects an invalid key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/alice",
      headers: { "x-api-key": "sk_not_a_real_key" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
  });

  it("accepts a valid key and identifies the account", async () => {
    const acc = await createAccount(app, "valid-key");
    const res = await api(app, acc.apiKey).get("/account");
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(acc.id);
  });

  it("stores only a hash of the key", async () => {
    const acc = await createAccount(app, "hash-check");
    const { rows } = await pool.query("SELECT api_key_hash FROM accounts WHERE id = $1", [acc.id]);
    expect(rows[0].api_key_hash).not.toBe(acc.apiKey);
    expect(rows[0].api_key_hash).toHaveLength(64);
  });

  it("protects consume, usage, history and plans", async () => {
    for (const [method, url] of [
      ["POST", "/consume"],
      ["GET", "/usage"],
      ["GET", "/requests"],
      ["GET", "/plans"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("account isolation", () => {
  it("hides one account's users, usage and history from another", async () => {
    const a = await createAccount(app, "iso-a");
    const b = await createAccount(app, "iso-b");
    const clientA = api(app, a.apiKey);
    const clientB = api(app, b.apiKey);

    await clientA.post("/users", { externalId: "alice" });
    await clientA.post("/consume", { userId: "alice", units: 5, requestId: "r1" });

    // B cannot read, modify, or consume for A's user
    expect((await clientB.get("/users/alice")).statusCode).toBe(404);
    expect((await clientB.put("/users/alice/plan", { planId: 4 })).statusCode).toBe(404);
    const consumeAsB = await clientB.post("/consume", { userId: "alice", units: 1, requestId: "x1" });
    expect(consumeAsB.statusCode).toBe(404);

    // B sees none of A's usage or history
    expect((await clientB.get("/usage")).json().users).toEqual([]);
    expect((await clientB.get("/requests")).json().requests).toEqual([]);

    // A's usage is unaffected by B's attempts
    const usageA = (await clientA.get("/usage")).json();
    expect(usageA.account.used).toBe(5);
  });

  it("does not let one account see or use another account's custom plan", async () => {
    const a = await createAccount(app, "plan-a");
    const b = await createAccount(app, "plan-b");
    const clientA = api(app, a.apiKey);
    const clientB = api(app, b.apiKey);

    const plan = (
      await clientA.post("/plans", { scope: "user", name: "Mine", monthlyAllowance: 10, maxPerRequest: 5 })
    ).json();

    expect((await clientB.get(`/plans/${plan.id}`)).statusCode).toBe(404);
    expect((await clientB.put(`/plans/${plan.id}`, { monthlyAllowance: 9999 })).statusCode).toBe(404);
    const assign = await clientB.post("/users", { externalId: "bob", planId: plan.id });
    expect(assign.statusCode).toBe(400);
    expect(assign.json().error.code).toBe("invalid_plan");
  });

  it("rejects the same externalId twice within an account but allows it across accounts", async () => {
    const a = await createAccount(app, "dup-a");
    const b = await createAccount(app, "dup-b");
    expect((await api(app, a.apiKey).post("/users", { externalId: "same" })).statusCode).toBe(201);
    expect((await api(app, a.apiKey).post("/users", { externalId: "same" })).statusCode).toBe(409);
    expect((await api(app, b.apiKey).post("/users", { externalId: "same" })).statusCode).toBe(201);
  });
});
