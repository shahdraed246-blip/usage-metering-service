# Load test results

50 connections, 15s per scenario, 2026-10-17T18:53:11.752Z

| Scenario | req/s | p50 (ms) | p99 (ms) | max (ms) | requests | non-2xx | errors | totals correct |
|---|---|---|---|---|---|---|---|---|
| spread: 50 accounts x 4 users | 871 | 52 | 131 | 203 | 13063 | 0 | 0 | yes |
| hot: 1 account x 20 users | 320 | 160 | 255 | 347 | 4805 | 0 | 0 | yes |
| limit: 1 user, allowance 1000 | 382 | 125 | 192 | 243 | 5726 | 0 | 0 | yes |
