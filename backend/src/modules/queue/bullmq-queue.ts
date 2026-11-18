import { Queue, Worker } from 'bullmq';
import type { TaskConsumer, TaskHandler, TaskMessage, TaskPublisher } from './task-queue.js';

export const TASK_QUEUE_NAME = 'export-tasks';

interface TaskJobData {
  taskId: string;
}

/** Sends task messages to BullMQ (Redis). */
export class BullMqPublisher implements TaskPublisher {
  private readonly queue: Queue<TaskJobData>;

  constructor(redisUrl: string, queueName = TASK_QUEUE_NAME) {
    this.queue = new Queue<TaskJobData>(queueName, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        // Retries are handled by our own task state in PostgreSQL, not by BullMQ.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10_000 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  }

  async publish(messages: TaskMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.queue.addBulk(
      messages.map((m) => ({ name: 'run-task', data: { taskId: m.taskId }, opts: { jobId: m.messageId } })),
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** Receives task messages and runs the handler. Many of these can run in parallel processes. */
export class BullMqConsumer implements TaskConsumer {
  private readonly worker: Worker<TaskJobData>;

  constructor(redisUrl: string, handler: TaskHandler, concurrency: number, queueName = TASK_QUEUE_NAME) {
    this.worker = new Worker<TaskJobData>(queueName, async (job) => handler(job.data.taskId), {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      concurrency,
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
  }
}
