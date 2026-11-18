# dispatch

Two background loops that run in the `dispatcher` process.

## Outbox dispatcher (`outbox-dispatcher.ts`)

Every 0.5 s: take up to 200 due outbox rows (`FOR UPDATE SKIP LOCKED`), publish them to BullMQ, mark them published.

- The message id is `<taskId>_<outboxId>`, so publishing the same row twice creates only one queue job.
- Several dispatchers can run together; `SKIP LOCKED` gives each different rows.
- Delayed retries are just outbox rows with a future `available_at`.

## Reconciler (`reconciler.ts`)

Every 5 s it repairs stuck work. Every step is safe to repeat.

| Problem                                                         | Fix                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A task is RUNNING but its lease expired (worker died or hung)   | Back to READY + new outbox row. If it used all attempts → FAILED, and the job FAILED. |
| A task is READY but no message was sent recently (message lost) | New outbox row.                                                                       |
| All chunks succeeded but FINALIZE is still WAITING              | Release it (safety net; normally done by the last chunk).                             |
