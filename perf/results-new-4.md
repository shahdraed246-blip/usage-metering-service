# Load test results

50 connections, 15s per scenario, 2026-10-17T19:13:25.892Z

| Scenario | req/s | p50 (ms) | p99 (ms) | max (ms) | requests | non-2xx | errors | totals correct |
|---|---|---|---|---|---|---|---|---|
| spread: 50 accounts x 4 users | 776 | 59 | 116 | 307 | 11647 | 0 | 0 | yes |
| hot: 1 account x 20 users | 213 | 233 | 403 | 459 | 3199 | 0 | 0 | yes |
| limit: 1 user, allowance 1000 | 185 | 263 | 431 | 592 | 2776 | 0 | 0 | yes |
