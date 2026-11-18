/**
 * The queue only carries "please run task X" messages. It is NOT the source of truth:
 * task status lives in PostgreSQL. A lost or duplicated message is therefore harmless —
 * the reconciler re-sends lost ones and the worker's claim ignores duplicates.
 *
 * This interface keeps BullMQ replaceable (e.g. Azure Service Bus in production).
 */
export interface TaskMessage {
  taskId: string;
  /** Deterministic id: publishing the same outbox row twice creates only one queue job. */
  messageId: string;
}

export interface TaskPublisher {
  publish(messages: TaskMessage[]): Promise<void>;
  close(): Promise<void>;
}

export interface TaskConsumer {
  close(): Promise<void>;
}

export type TaskHandler = (taskId: string) => Promise<unknown>;
