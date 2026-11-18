import { loadEnv, type Env } from '../config/env.js';
import { createPool, type Db } from '../db/pool.js';
import { logger, type Logger } from '../lib/logger.js';
import { LocalStorage } from '../modules/storage/local-storage.js';

/** Shared startup for every process: settings, database pool, storage, logger. */
export interface Runtime {
  env: Env;
  db: Db;
  storage: LocalStorage;
  logger: Logger;
}

export function createRuntime(): Runtime {
  const env = loadEnv();
  return {
    env,
    db: createPool(env.DATABASE_URL),
    storage: new LocalStorage(env.STORAGE_DIR),
    logger,
  };
}

/** Calls `cleanup` once on SIGINT / SIGTERM, then exits. */
export function onShutdown(log: Logger, cleanup: () => Promise<void>): void {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'Shutting down');
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

/**
 * Runs `fn` every `intervalMs` (never overlapping). Errors are logged and the loop continues.
 * Returns a stop function that waits for the current run to finish.
 */
export function every(log: Logger, name: string, intervalMs: number, fn: () => Promise<unknown>): () => Promise<void> {
  let running = true;
  let current: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const loop = () => {
    current = fn()
      .then(() => undefined)
      .catch((err: unknown) => log.error({ err, loop: name }, 'Loop iteration failed'))
      .finally(() => {
        if (running) timer = setTimeout(loop, intervalMs);
      });
  };
  loop();

  return async () => {
    running = false;
    clearTimeout(timer);
    await current;
  };
}
