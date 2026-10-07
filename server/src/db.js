import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config, projectRoot } from './config.js';

export const pool = new pg.Pool({
  // DATABASE_URL (e.g. Neon) wins; its "?sslmode=require" turns on encryption.
  ...(config.db.connectionString
    ? { connectionString: config.db.connectionString }
    : {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
      }),
  max: 5,
  // Close idle connections quickly: a serverless database like Neon only pauses (and
  // stops using free compute hours) when no connection is open.
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000, // a paused Neon database takes a moment to wake
});

export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Both schema files are written with CREATE TABLE / CREATE INDEX IF NOT EXISTS,
 * so running them on every boot is safe and means a fresh database just works.
 */
export async function ensureSchema() {
  for (const file of ['schema.sql', 'schema-verifier.sql', 'schema-budget.sql']) {
    const sql = await fs.readFile(path.join(projectRoot, file), 'utf8');
    await pool.query(sql);
  }
}

/** Is a stored row still current? */
export function isFresh(timestamp, maxAgeDays) {
  if (!timestamp) return false;
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / 86_400_000;
  return Number.isFinite(ageDays) && ageDays <= maxAgeDays;
}
