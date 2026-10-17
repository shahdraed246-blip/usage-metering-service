# Load test results

50 connections, 15s per scenario, 2026-10-17T19:12:19.067Z

| Scenario | req/s | p50 (ms) | p99 (ms) | max (ms) | requests | non-2xx | errors | totals correct |
|---|---|---|---|---|---|---|---|---|
| spread: 50 accounts x 4 users | 522 | 89 | 176 | 394 | 7835 | 0 | 0 | yes |
| hot: 1 account x 20 users | 160 | 306 | 504 | 534 | 2394 | 0 | 0 | yes |
| limit: 1 user, allowance 1000 | 180 | 271 | 399 | 445 | 2696 | 0 | 0 | yes |
