# queue

The queue carries tiny messages: **"run task X"**. It is not the source of truth — PostgreSQL is.

- `task-queue.ts` – the interface (`TaskPublisher`, `TaskConsumer`). Swap BullMQ for another broker
  (for example Azure Service Bus) by writing a new adapter. Nothing else changes.
- `bullmq-queue.ts` – the BullMQ (Redis) adapter.

Choices in the adapter:

- `attempts: 1` – BullMQ does not retry. Our own task state in PostgreSQL decides retries and backoff.
- `jobId` = deterministic message id – the same outbox row published twice becomes one BullMQ job.
- Finished BullMQ jobs are removed after an hour; their history lives in PostgreSQL.
- Redis runs with `appendonly yes`. Even if Redis loses messages, the reconciler sends them again.
