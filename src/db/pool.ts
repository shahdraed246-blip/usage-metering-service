import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://app:app@localhost:5433/metering",
  max: 20,
});
