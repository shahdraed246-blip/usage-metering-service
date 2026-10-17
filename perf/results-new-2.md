# Load test results

50 connections, 15s per scenario, 2026-10-17T19:11:12.176Z

| Scenario | req/s | p50 (ms) | p99 (ms) | max (ms) | requests | non-2xx | errors | totals correct |
|---|---|---|---|---|---|---|---|---|
| spread: 50 accounts x 4 users | 770 | 60 | 120 | 256 | 11553 | 0 | 0 | yes |
| hot: 1 account x 20 users | 206 | 232 | 457 | 585 | 3088 | 0 | 0 | yes |
| limit: 1 user, allowance 1000 | 194 | 246 | 429 | 476 | 2909 | 0 | 0 | yes |
