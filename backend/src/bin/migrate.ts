import { migrate } from '../db/migrate.js';
import { createRuntime } from './runtime.js';

const { db, logger } = createRuntime();

try {
  const applied = await migrate(db);
  logger.info({ applied }, applied.length ? 'Migrations applied' : 'Database is up to date');
} finally {
  await db.end();
}
