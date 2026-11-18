import { systemClock } from '../lib/clock.js';
import { Scheduler } from '../modules/scheduler/scheduler.js';
import { createRuntime, every, onShutdown } from './runtime.js';

const { env, db, logger } = createRuntime();
const log = logger.child({ process: 'scheduler' });

const scheduler = new Scheduler({
  db,
  clock: systemClock,
  logger: log,
  settings: { cutoffSafetySeconds: env.CUTOFF_SAFETY_SECONDS, maxAttempts: env.TASK_MAX_ATTEMPTS },
});

const stop = every(log, 'scheduler', env.SCHEDULER_INTERVAL_MS, () => scheduler.tick());
log.info({ intervalMs: env.SCHEDULER_INTERVAL_MS }, 'Scheduler started');

onShutdown(log, async () => {
  await stop();
  await db.end();
});
