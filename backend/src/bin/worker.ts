import { hostname } from 'node:os';
import { BullMqConsumer } from '../modules/queue/bullmq-queue.js';
import { TaskRunner, type FaultHooks } from '../modules/worker/task-runner.js';
import { createRuntime, onShutdown } from './runtime.js';

const { env, db, storage, logger } = createRuntime();
const workerId = `${hostname()}-${process.pid}`;
const log = logger.child({ process: 'worker', workerId });

/**
 * Demo only (DEMO_CRASH_CHUNK=n): die abruptly on the first attempt of chunk n, after its data was
 * written but before it was saved as done. The lease then expires and another worker redoes it.
 * Only attempt 1 crashes, so the chunk cannot loop forever.
 */
const demoCrash: FaultHooks | undefined =
  env.DEMO_CRASH_CHUNK === undefined
    ? undefined
    : {
        afterWrite: async (task) => {
          if (task.kind === 'CHUNK' && task.seq === env.DEMO_CRASH_CHUNK && task.attempt === 1) {
            log.error({ jobId: task.job_id, taskId: task.id, seq: task.seq }, 'DEMO: worker crashes now (exit 137)');
            process.exit(137);
          }
        },
      };
if (demoCrash) log.warn({ chunk: env.DEMO_CRASH_CHUNK }, 'DEMO crash mode is ON');

const runner = new TaskRunner({
  db,
  storage,
  workerId,
  logger: log,
  settings: {
    leaseSeconds: env.TASK_LEASE_SECONDS,
    workspaceMaxRunning: env.WORKSPACE_MAX_RUNNING_TASKS,
    retryBaseMs: env.RETRY_BASE_MS,
  },
  faults: demoCrash,
});

const consumer = new BullMqConsumer(env.REDIS_URL, (taskId) => runner.run(taskId), env.WORKER_CONCURRENCY);
log.info({ concurrency: env.WORKER_CONCURRENCY }, 'Worker started');

onShutdown(log, async () => {
  await consumer.close();
  await db.end();
});
