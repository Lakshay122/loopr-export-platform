import { z } from 'zod';

/** All runtime settings come from environment variables, checked once at startup. */
const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://loopr:loopr@localhost:5432/loopr'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  STORAGE_DIR: z.string().default('./data'),
  API_PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  TASK_LEASE_SECONDS: z.coerce.number().int().min(5).default(60),
  TASK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  WORKSPACE_MAX_RUNNING_TASKS: z.coerce.number().int().min(1).default(4),
  RETRY_BASE_MS: z.coerce.number().int().min(10).default(2000),

  // Dispatcher / reconciler
  DISPATCH_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),
  // A READY task with no queue message for this long is re-sent.
  RECONCILE_STALE_SECONDS: z.coerce.number().int().min(1).default(30),

  // Scheduler
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(100).default(10_000),
  // Records finalized in the last N seconds are not exported yet, so in-progress
  // source writes with an older finalized_at cannot slip behind a cutoff.
  CUTOFF_SAFETY_SECONDS: z.coerce.number().int().min(0).default(5),

  // Demo only: the worker process exits abruptly (like a killed container) on the FIRST attempt of
  // chunk number N of any export, to show crash recovery. Unset = off. Never set in production.
  DEMO_CRASH_CHUNK: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(0).optional()),

  // Demo only: an API endpoint that adds fake inspection records (the UI "Demo tool"). Off unless set to "true".
  DEMO_TOOLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
