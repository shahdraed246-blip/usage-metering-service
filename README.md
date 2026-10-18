# Usage Metering and Quota Service

A backend service that other applications call to track usage and decide whether their users may perform an action.
An application (an **account**) has a plan with limits shared by all its users, and each **user** has a plan with individual limits. Before doing work, the application asks the service to consume units for a user. The service checks both plans, records the decision, and counts the usage only if the request is accepted.

Stack: TypeScript (Fastify), PostgreSQL, Docker Compose. One service and one database.

## Quick start

Requirements: Docker with Docker Compose. To run the tests and the load tests from your machine you also need Node.js 20 or newer (developed on Node 22), npm and curl; `npm install` also brings autocannon, the load test tool.

```bash
docker compose up --build
```

This starts three containers and prepares the database on its own (migrations and predefined plans run at startup):

| Service | URL | What it is |
|---|---|---|
| `api` | http://localhost:3000 | The metering service |
| `client` | http://localhost:8080 | Demo application that calls the service with an API key |
| `db` | localhost:5433 | PostgreSQL (data is kept in a Docker volume) |

Check it: `curl localhost:3000/health` returns `{"status":"ok"}`.

Configuration (all optional, defaults work with the compose file):

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://app:app@localhost:5433/metering` | api |
| `PORT` | `3000` (api), `8080` (client) | api, client |
| `API_URL` | `http://localhost:3000` | client |

## Demo client

Open http://localhost:8080. It is a fake "document processor" whose backend holds an account API key (the browser never sees it). "Processing a document" costs units. On startup the client creates a fresh account with a small custom account plan (60 units per month) and two users on different plans: **alice** on Premium (10000 per month, 200 per request) and **bob** on Basic (1000 per month, 20 per request).

Scenario to try (use **Reset demo** to start over):

1. alice processes 30 units: accepted.
2. bob processes 25 units: **rejected by the user's per-request limit** (Basic allows 20).

   ![User limit](docs/demo-user-limit.png)
3. alice processes 25 units: accepted (55 of 60 used by the account).
4. alice processes 10 units: **rejected by the account's shared monthly allowance** (only 5 left), even though alice herself has plenty left.

   ![Account limit](docs/demo-account-limit.png)
5. Switch the account plan to **Pro** with the button, then alice processes 10 units: accepted. Usage is kept (it does not reset), and the client code did not change.

   ![Plan switch](docs/demo-plan-switch.png)

## Predefined plans

Created at startup, read-only, available to every account.

| Plan | Scope | Monthly allowance | Max per request |
|---|---|---|---|
| Starter | account | 10,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 1,000 | 20 |
| Premium | user | 10,000 | 200 |

A new account gets **Starter** and a new user gets **Basic** unless a plan is given.

## Getting and using an API key

Creating an account is public and returns the API key. **The key is shown only once**; only its SHA-256 hash is stored.

```bash
curl -s -X POST localhost:3000/accounts -H 'content-type: application/json' -d '{"name":"Acme"}'
# {"id":1,"name":"Acme","planId":1,"apiKey":"sk_3f9a..."}
```

Every other endpoint (except `/health`) needs the key in the `x-api-key` header. The key identifies the calling account and gives access only to that account's data. A missing key returns `401 missing_api_key`, an unknown key returns `401 invalid_api_key`. A user that belongs to another account is reported as `404 user_not_found`.

```bash
KEY=sk_3f9a...
curl -s localhost:3000/account -H "x-api-key: $KEY"
```

## API

All bodies are JSON. Errors always look like `{"error":{"code":"...","message":"...","details":...}}`.

| Method and path | Purpose |
|---|---|
| `POST /accounts` | Create an account, returns the API key (public). Body: `name`, optional `planId` (account plan) |
| `GET /account` | The calling account and its current plan |
| `PUT /account/plan` | Switch the account plan. Body: `planId` |
| `POST /users` | Register a user. Body: `externalId`, optional `planId` (user plan) |
| `GET /users/:externalId` | A user and the plan limits applied to them |
| `PUT /users/:externalId/plan` | Assign or change a user's plan. Body: `planId` |
| `POST /plans` | Create a custom plan. Body: `scope` (`account` or `user`), `name`, `monthlyAllowance`, `maxPerRequest` |
| `GET /plans` | Predefined plans plus the account's own plans |
| `GET /plans/:id` | One plan |
| `PUT /plans/:id` | Update a custom plan (any of `name`, `monthlyAllowance`, `maxPerRequest`). Predefined plans return `403 plan_read_only` |
| `POST /consume` | Ask to consume units (see below) |
| `GET /usage?month=YYYY-MM` | Consumed and remaining units for the account and each user. Defaults to the current UTC month |
| `GET /requests` | Request history, newest first. Query: `limit` (1 to 100, default 20), `cursor`, `userId`, `month` |
| `GET /health` | Liveness and database check |

### Consume units

```bash
curl -s -X POST localhost:3000/consume -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"userId":"alice","units":10,"requestId":"order-42"}'
```

`userId` is the user's `externalId`, `units` is a positive whole number, `requestId` is chosen by the caller and used for safe retries.

Accepted:

```json
{"accepted":true,"replayed":false,"requestId":"order-42","units":10,"month":"2026-10-01","reason":null,
 "user":{"externalId":"alice","used":10,"remaining":990,"monthlyAllowance":1000,"maxPerRequest":20},
 "account":{"used":10,"remaining":9990,"monthlyAllowance":10000,"maxPerRequest":100}}
```

Rejected (nothing is consumed). `reason.by` is `account` or `user`, `reason.rule` is `max_per_request` or `monthly_allowance`:

```json
{"accepted":false,"replayed":false,"requestId":"order-43","units":10,"month":"2026-10-01",
 "reason":{"by":"account","rule":"monthly_allowance"},
 "user":{"externalId":"alice","used":10,"remaining":990,"monthlyAllowance":1000,"maxPerRequest":20},
 "account":{"used":10,"remaining":5,"monthlyAllowance":15,"maxPerRequest":100}}
```

Both accepted and rejected decisions return HTTP 200, so check `accepted`. Other statuses: `400 invalid_body`, `401`, `404 user_not_found`, `409 idempotency_conflict`.

### Pagination

`GET /requests` returns `{"requests":[...],"nextCursor":37}`. Pass `nextCursor` back as `?cursor=37` for the next page; `nextCursor` is `null` on the last page. Each item has `requestId`, `userId`, `units`, `accepted`, `reason` (null when accepted) and `createdAt`.

## How plans affect consumption

Both plans apply together to every request. There are two rule types, available on account plans and on user plans:

- **Monthly allowance**: total units available in a UTC calendar month.
- **Maximum units per request**: the largest amount a single request may consume.

A request is accepted only if **all four** checks pass; otherwise nothing is consumed. Checks run in a fixed order and the first violated rule is the one reported: user per-request, account per-request, user monthly, account monthly.

Example (account: 10,000 per month and 100 per request; user: 1,000 per month and 20 per request):

- 25 units: rejected by the **user's** per-request limit, even though both monthly allowances have room.
- 10 units: accepted; adds 10 to the user's usage and 10 to the account's usage.
- 10 units when the account has only 5 left: rejected by the **account's** monthly allowance, even if the user has plenty left.

The account's usage is the sum of accepted usage of its users. Users who share a plan do not share an allowance. Usage belongs to the UTC month in which the request is processed; a new month starts at zero for both levels and previous months stay queryable (`GET /usage?month=2026-09`, `GET /requests?month=2026-09`).

## Plan changes

- **Custom plans** are created, viewed and updated by the account that owns them (`/plans`). Several users may share one plan definition. Other accounts cannot see or use them. Predefined plans are read-only.
- **Updates apply to the next request.** Limits are read from the database on every `consume`, so no restart or redeploy is needed. Updating a custom plan affects everyone assigned to it.
- **Switching plans keeps usage.** Usage is stored per user and per month, not per plan, so a switch never grants a fresh allowance.
- **Allowance lowered below existing usage:** `remaining` is shown as 0 and further consumption is rejected at that level until the allowance grows again or the month changes.
- **History is preserved.** Plan changes never touch stored requests.
- A user plan must have scope `user` and an account plan scope `account`; a plan must be predefined or owned by the calling account.

## Retries (idempotency)

`requestId` is chosen by the caller and unique per account.

- Retrying a request with the same `requestId`, user and units returns the **same decision** with `"replayed": true` and counts nothing again. This also applies to rejections.
- The same `requestId` with a different user or units returns `409 idempotency_conflict`.
- Two identical requests arriving at the same moment are serialized; exactly one is counted.
- A request for an unknown user returns 404 and is not recorded, so its `requestId` stays free.
- A replay reports the **current** remaining units, not the values at the time of the original request.

## Product assumptions

The brief leaves these open; these are the choices made, applied consistently.

1. **One resource**, called units. Units are positive whole numbers, up to `Number.MAX_SAFE_INTEGER`.
2. **Creating an account is public** (no admin role), because roles and end-user login are out of scope. Anyone can create an account and gets its key.
3. **Decisions return HTTP 200** whether accepted or rejected; the body says which. HTTP errors are reserved for bad input, bad keys, unknown users and idempotency conflicts.
4. **A rejection retried later is still a rejection.** Rejected decisions are stored too, so after raising an allowance the caller must use a new `requestId`.
5. **Only the first violated rule is reported**, in the fixed order above, even if several rules would reject.
6. **A new account defaults to Starter and a new user to Basic.** `POST /accounts` accepts only predefined account plans, since a new account owns no plans yet.
7. **`remaining` always uses the plans applied today**, including when querying a past month.
8. **No deletion**: accounts, users and plans cannot be deleted, and API keys cannot be rotated or revoked.
9. **User ids** (`externalId`) are the application's own ids, unique within an account and free to repeat across accounts.

## Design

### Data model

| Table | Purpose |
|---|---|
| `plans` | Rules. `account_id` is NULL for predefined plans; `scope` is `account` or `user` |
| `accounts` | Name, SHA-256 hash of the API key, current plan |
| `users` | Belongs to an account; `UNIQUE (account_id, external_id)`; current plan |
| `account_usage` | Units used per account per month |
| `user_usage` | Units used per user per month |
| `requests` | Every decision (accepted or rejected, with the blocking level and rule); `UNIQUE (account_id, request_id)` |
| `schema_migrations` | Which migrations already ran |

Migrations are plain SQL files in `migrations/`, applied in order at startup (guarded by an advisory lock so several instances do not race). The predefined plans are one of them.

### The consume transaction

1. Outside the lock, one statement resolves the user (scoped to the calling account) and makes sure this month's counter rows exist.
2. In a transaction, lock **only the account's counter row** (`SELECT ... FOR UPDATE`). Every request of an account takes this lock first, so one account's requests run one at a time. That also protects the user's counter, which is only written by `consume` after the account lock is held.
3. One statement reads usage, both plans and any earlier request with the same `requestId`. It starts after the lock is granted, so it sees the latest committed values.
4. Evaluate the rules in memory. If accepted, one statement updates both counters and inserts the request. If rejected, insert the request only.
5. Commit.

Because the account counter is shared by design, requests of one account cannot run in parallel; different accounts do not block each other. Correctness comes from the database (row locks, transactions and the unique constraint), not from application memory, so it should also hold with several API instances, but I only tested it with one API process (many concurrent database connections).

### Code organization

`src/routes/` handles HTTP only (validation, status codes). `src/services/consume.ts` holds the accounting and rules, `src/services/auth.ts` the API key logic, `src/db/` the connection pool and migrations, `src/errors.ts` one error shape. `src/app.ts` builds the app so tests can run it without a server.

API keys are 192 random bits, so a plain SHA-256 hash is enough (it protects the keys if the database leaks; there is no password to brute force).

## Tests

30 automated tests (vitest) run against a separate database `metering_test`:

- API key validation (missing, invalid, valid, stored as a hash) and account isolation (users, usage, history, custom plans, consume).
- Rules: user and account, per-request and monthly; shared-plan users keep separate usage.
- Idempotency: replayed accept and reject, 409 on a changed payload, same id across accounts.
- Plan changes: updates apply to the next request, usage preserved, allowance below usage, history kept.
- Months, usage and history pagination.
- Concurrency: 30 parallel requests against a 20-unit user (exactly 20 accepted), 60 requests from three users against a shared 25-unit account (exactly 25), and 10 identical parallel requests (counted once).

```bash
docker compose up -d db
docker compose exec db psql -U app -d metering -c "CREATE DATABASE metering_test;"
npm install
npm test
```

## Performance

Tools are in `scripts/` and results in `perf/`.

```bash
docker compose up -d db api
npm run loadtest                 # three scenarios, writes perf/results.md
bash scripts/bench.sh <label>    # same on a fresh database, saved as perf/results-<label>.md
# bench.sh runs "docker compose down -v": it deletes the database volume (all data)

# While a load test runs, in a second terminal, sample what Postgres connections wait on
for i in $(seq 1 16); do docker compose exec -T db psql -U app -d metering -Atc "SELECT state, coalesce(wait_event_type,'-'), coalesce(wait_event,'-'), count(*) FROM pg_stat_activity WHERE datname='metering' AND state<>'idle' GROUP BY 1,2,3 ORDER BY 4 DESC"; sleep 3; done
```

Scenarios (autocannon, 50 connections, 15 s each, every request is a `consume`):

- **spread**: 50 accounts with 4 users each, random users.
- **hot**: one account with 20 users, so every request fights for the same shared counter.
- **limit**: one user with a 1,000 allowance and thousands of 1-unit requests; exactly 1,000 must be accepted.

After each scenario the script checks the totals through the API, and `scripts/check-invariants.sql` checks them directly in the database: account counter = sum of its users = sum of its accepted requests. All runs below had 0 errors, 0 non-2xx and consistent totals.

### What I found

Sampling `pg_stat_activity` during the hot scenario (`perf/pg-activity.txt`) showed 16 to 18 of the 20 busy connections waiting on a row lock (`Lock | tuple`), so the bottleneck was the time the account's counter lock was held. At that point `consume` made about 8 database round trips while holding it.

### The change

The lock is now taken on the account row only (the user row was redundant, see above), and everything is read in one statement and written in one statement, so about 4 round trips run under the lock, and fewer in total.

### Results (paired runs on a fresh database, old and new twice each, requests per second)

| Scenario | Before | After | Change | p50 before to after |
|---|---|---|---|---|
| spread | 509 (495, 522) | 773 (770, 776) | +52% | 91 ms to 60 ms |
| hot account | 160 (160, 160) | 210 (206, 213) | +31% | 305 ms to 233 ms |
| single user | 176 (172, 180) | 190 (194, 185) | +8% | 279 ms to 255 ms |

Raw numbers: `perf/results-old-1.md`, `results-new-2.md`, `results-old-3.md`, `results-new-4.md`.

### What I learned

- I expected the spread scenario to gain least, since it has no lock contention. It gained most: fewer round trips help every request, not only contended ones.
- My first before/after comparison was misleading: it ran on a database that had grown over many runs, and the machine was in a different state. Absolute numbers also differ between sessions (the same old code ran at about 320 req/s on the hot scenario earlier and 160 later). Only paired runs in the same session on a fresh database are comparable, and even those are only two runs per version.
- An early "totals incorrect" result was a false alarm: the check read `/usage` while in-flight requests were still finishing. The script now waits, and the database check confirms it.
- A single hot account tops out around 200 requests per second here (about 5 ms per request inside the lock). That is the price of an exact shared counter. Ideas not implemented: batching several requests per transaction or sharded counters with periodic reconciliation, which trade exactness for speed.

## Known limitations

- A single account is limited to roughly 200 `consume` calls per second on a laptop (see above); different accounts scale independently.
- Creating accounts is unauthenticated; no admin, rate limiting, key rotation or revocation.
- No deletion of accounts, users or plans; plan history is not versioned (the history stores decisions, not the limits that applied).
- Only one resource type; a user can belong to one account.
- Numbers are handled as JavaScript numbers (safe up to 2^53).
- `GET /usage` computes `remaining` against today's plans, even for past months.
- The demo client keeps its state in memory and creates a new account on every start.
- Load results come from one laptop with the database, API, client and load generator on the same machine, so they show relative effects, not production capacity.
- Only the two required rule types (monthly allowance, maximum per request) are implemented; no additional rules.
