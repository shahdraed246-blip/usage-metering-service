import pg from "pg";

// Return BIGINT (OID 20) as JS number. Safe up to 2^53, far above any quota we use.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://app:app@localhost:5433/metering",
  max: 20,
});
