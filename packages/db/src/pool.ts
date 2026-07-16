import pg from "pg";

const { Pool } = pg;

export function createPool(
  connectionString = process.env.DATABASE_URL,
): pg.Pool {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({
    connectionString,
    application_name: process.env.SERVICE_ROLE ?? "goaldrop",
    max: Number.parseInt(process.env.DATABASE_POOL_SIZE ?? "20", 10),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;
