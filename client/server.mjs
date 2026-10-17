import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const API = process.env.API_URL ?? "http://localhost:3000";
const PORT = Number(process.env.PORT ?? 8080);

// The API key lives only here, on the client's backend. The browser never sees it.
let state = null;

async function call(method, path, body, key = state?.key) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(API + "/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("metering service is not reachable at " + API);
}

// Creates a fresh account (so usage starts at zero) with two users on different plans
async function setup() {
  const acc = (await call("POST", "/accounts", { name: "Demo App" }, null)).body;
  const key = acc.apiKey;

  const plans = {};
  for (const p of (await call("GET", "/plans", null, key)).body.plans) plans[p.name] = p.id;

  // A small custom account plan so the shared limit is easy to reach
  const demo = (
    await call("POST", "/plans", {
      scope: "account", name: "Demo Account", monthlyAllowance: 60, maxPerRequest: 100,
    }, key)
  ).body;
  plans["Demo Account"] = demo.id;
  await call("PUT", "/account/plan", { planId: demo.id }, key);

  await call("POST", "/users", { externalId: "alice", planId: plans.Premium }, key);
  await call("POST", "/users", { externalId: "bob", planId: plans.Basic }, key);

  state = { key, plans };
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

function send(res, status, data, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname;

    if (req.method === "GET" && path === "/") {
      const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && path === "/api/state") {
      const [account, usage, history] = await Promise.all([
        call("GET", "/account"),
        call("GET", "/usage"),
        call("GET", "/requests?limit=10"),
      ]);
      return send(res, 200, {
        account: account.body,
        usage: usage.body,
        history: history.body.requests,
        plans: state.plans,
      });
    }

    // Simulated business action: "process a document" costing `units`
    if (req.method === "POST" && path === "/api/consume") {
      const { userId, units } = await readJson(req);
      const out = await call("POST", "/consume", { userId, units: Number(units), requestId: randomUUID() });
      return send(res, 200, out.body);
    }

    // Plan changes go through the metering API; this client code never changes
    if (req.method === "POST" && path === "/api/switch") {
      const { type, userId, plan } = await readJson(req);
      const planId = state.plans[plan];
      const out =
        type === "account"
          ? await call("PUT", "/account/plan", { planId })
          : await call("PUT", `/users/${userId}/plan`, { planId });
      return send(res, 200, out.body);
    }

    if (req.method === "POST" && path === "/api/reset") {
      await setup();
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "not_found" });
  } catch (err) {
    send(res, 500, { error: String(err) });
  }
});

await waitForApi();
await setup();
server.listen(PORT, "0.0.0.0", () => console.log(`demo client on http://localhost:${PORT}`));
