import autocannon from "autocannon";
import { writeFile } from "node:fs/promises";

const API = process.env.API_URL ?? "http://localhost:3000";
const DURATION = Number(process.env.DURATION ?? 15);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);
const BIG = 1_000_000_000;
const runId = Date.now().toString(36);

async function call(method, path, body, key) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// An account with `userCount` users; limits are [monthlyAllowance, maxPerRequest]
async function makeAccount(name, userCount, { acct = [BIG, 1000], user = [BIG, 1000] } = {}) {
  const { apiKey } = await call("POST", "/accounts", { name });
  const ap = await call("POST", "/plans", { scope: "account", name: "lt-acct", monthlyAllowance: acct[0], maxPerRequest: acct[1] }, apiKey);
  await call("PUT", "/account/plan", { planId: ap.id }, apiKey);
  const up = await call("POST", "/plans", { scope: "user", name: "lt-user", monthlyAllowance: user[0], maxPerRequest: user[1] }, apiKey);
  const users = [];
  for (let i = 0; i < userCount; i++) {
    await call("POST", "/users", { externalId: `u${i}`, planId: up.id }, apiKey);
    users.push(`u${i}`);
  }
  return { apiKey, users };
}

// Correctness after load: the account total equals the sum of its users and never exceeds the allowance
async function verify(targets, expectedUserUsed) {
  let ok = true;
  let accepted = 0;
  for (const t of targets) {
    const u = await call("GET", "/usage", null, t.apiKey);
    const sum = u.users.reduce((s, x) => s + x.used, 0);
    accepted += u.account.used;
    if (sum !== u.account.used || u.account.used > u.account.monthlyAllowance) ok = false;
    if (expectedUserUsed !== undefined && u.users[0].used !== expectedUserUsed) ok = false;
  }
  return { ok, unitsCounted: accepted };
}

async function run(title, targets, unitsFn, expectedUserUsed) {
  console.log(`\n== ${title} ==`);
  let n = 0;
  const r = await autocannon({
    url: API,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        method: "POST",
        path: "/consume",
        setupRequest: (req) => {
          const t = targets[Math.floor(Math.random() * targets.length)];
          const user = t.users[Math.floor(Math.random() * t.users.length)];
          req.headers = { "content-type": "application/json", "x-api-key": t.apiKey };
          req.body = JSON.stringify({ userId: user, units: unitsFn(), requestId: `${runId}-${n++}` });
          return req;
        },
      },
    ],
  });
  const v = await verify(targets, expectedUserUsed);
  const row = {
    title,
    reqPerSec: Math.round(r.requests.average),
    p50: r.latency.p50,
    p99: r.latency.p99,
    max: r.latency.max,
    total: r.requests.total,
    non2xx: r.non2xx,
    errors: r.errors + r.timeouts,
    correct: v.ok ? "yes" : "NO",
  };
  console.log(row);
  return row;
}

console.log(`API ${API}, ${CONNECTIONS} connections, ${DURATION}s per scenario`);

const spread = [];
for (let i = 0; i < 50; i++) spread.push(await makeAccount(`spread-${i}`, 4));
const hot = [await makeAccount("hot", 20)];
// user allowance 1000, 1 unit per request: exactly 1000 must be accepted, however many arrive
const limit = [await makeAccount("limit", 1, { acct: [BIG, 10], user: [1000, 10] })];

const rows = [];
rows.push(await run("spread: 50 accounts x 4 users", spread, () => 1 + Math.floor(Math.random() * 5)));
rows.push(await run("hot: 1 account x 20 users", hot, () => 1 + Math.floor(Math.random() * 5)));
rows.push(await run("limit: 1 user, allowance 1000", limit, () => 1, 1000));

const md = [
  `# Load test results`,
  ``,
  `${CONNECTIONS} connections, ${DURATION}s per scenario, ${new Date().toISOString()}`,
  ``,
  `| Scenario | req/s | p50 (ms) | p99 (ms) | max (ms) | requests | non-2xx | errors | totals correct |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.title} | ${r.reqPerSec} | ${r.p50} | ${r.p99} | ${r.max} | ${r.total} | ${r.non2xx} | ${r.errors} | ${r.correct} |`),
  ``,
].join("\n");
await writeFile("perf/results.md", md);
console.log("\nSaved perf/results.md");
