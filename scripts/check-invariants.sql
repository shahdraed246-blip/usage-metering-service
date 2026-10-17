-- Lists every account whose counters disagree this month. Zero rows means all totals are consistent:
-- account counter = sum of its users' counters = sum of its accepted requests.
SELECT a.id, a.name,
       au.used AS account_used,
       COALESCE(us.s, 0) AS users_sum,
       COALESCE(rq.s, 0) AS accepted_sum
  FROM accounts a
  JOIN account_usage au
    ON au.account_id = a.id AND au.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
  LEFT JOIN (
    SELECT u.account_id, SUM(uu.used) AS s
      FROM user_usage uu JOIN users u ON u.id = uu.user_id
     WHERE uu.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     GROUP BY u.account_id
  ) us ON us.account_id = a.id
  LEFT JOIN (
    SELECT account_id, SUM(units) AS s
      FROM requests
     WHERE accepted AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
     GROUP BY account_id
  ) rq ON rq.account_id = a.id
 WHERE au.used <> COALESCE(us.s, 0) OR au.used <> COALESCE(rq.s, 0);
