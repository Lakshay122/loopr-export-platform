import { createApp } from '../api/app.js';
import { systemClock } from '../lib/clock.js';
import { createRuntime, onShutdown } from './runtime.js';

const { env, db, storage, logger } = createRuntime();
const log = logger.child({ process: 'api' });

const app = createApp({
  db,
  storage,
  clock: systemClock,
  settings: { cutoffSafetySeconds: env.CUTOFF_SAFETY_SECONDS, maxAttempts: env.TASK_MAX_ATTEMPTS },
  demoTools: env.DEMO_TOOLS,
});

const server = app.listen(env.API_PORT, () => log.info({ port: env.API_PORT }, 'API listening'));

onShutdown(log, async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.end();
});
