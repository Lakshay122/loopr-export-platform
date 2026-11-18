import { dispatchOutbox } from '../modules/dispatch/outbox-dispatcher.js';
import { reconcile } from '../modules/dispatch/reconciler.js';
import { BullMqPublisher } from '../modules/queue/bullmq-queue.js';
import { createRuntime, every, onShutdown } from './runtime.js';

const { env, db, logger } = createRuntime();
const log = logger.child({ process: 'dispatcher' });
const publisher = new BullMqPublisher(env.REDIS_URL);

const stopDispatch = every(log, 'dispatch', env.DISPATCH_INTERVAL_MS, async () => {
  const sent = await dispatchOutbox(db, publisher);
  if (sent) log.debug({ sent }, 'Outbox published');
});

const stopReconcile = every(log, 'reconcile', env.RECONCILE_INTERVAL_MS, async () => {
  const result = await reconcile(db, { staleSeconds: env.RECONCILE_STALE_SECONDS });
  if (Object.values(result).some((n) => n > 0)) log.info(result, 'Reconciled stuck work');
});

log.info('Dispatcher and reconciler started');

onShutdown(log, async () => {
  await Promise.all([stopDispatch(), stopReconcile()]);
  await publisher.close();
  await db.end();
});
