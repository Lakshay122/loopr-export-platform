import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';
import { withTransaction } from './pool.js';

// SQL files live in src/db/migrations. The Docker image copies them next to dist/db as well.
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies every *.sql file in order, once. Safe to run on every start. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const ran = await withTransaction(db, async (client) => {
      // Lock so two processes starting together do not apply the same file twice.
      await client.query('SELECT pg_advisory_xact_lock(4242)');
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) return false;
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}
