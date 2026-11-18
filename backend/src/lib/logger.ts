import { pino } from 'pino';

/**
 * Structured JSON logs. Add tenantId / workspaceId / jobId / taskId as fields
 * (logger.child({ jobId })) so one job can be followed across processes.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.SERVICE_NAME ?? 'export-platform' },
});

export type Logger = typeof logger;
