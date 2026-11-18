import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { TEST_DATABASE_URL } from './helpers/env.js';

/** Runs once before all tests: rebuilds the test database schema from the migrations. */
export default async function setup(): Promise<void> {
  const db = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
  } catch (err) {
    throw new Error(
      `Cannot prepare the test database at ${TEST_DATABASE_URL}. Start it with "docker compose up -d postgres redis".\n${String(err)}`,
    );
  } finally {
    await db.end();
  }
}
