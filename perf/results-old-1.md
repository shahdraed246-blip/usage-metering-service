# Load test results

50 connections, 15s per scenario, 2026-10-17T19:10:05.509Z

| Scenario | req/s | p50 (ms) | p99 (ms) | max (ms) | requests | non-2xx | errors | totals correct |
|---|---|---|---|---|---|---|---|---|
| spread: 50 accounts x 4 users | 495 | 93 | 210 | 382 | 7422 | 0 | 0 | yes |
| hot: 1 account x 20 users | 160 | 303 | 476 | 494 | 2396 | 0 | 0 | yes |
| limit: 1 user, allowance 1000 | 172 | 287 | 409 | 442 | 2575 | 0 | 0 | yes |
