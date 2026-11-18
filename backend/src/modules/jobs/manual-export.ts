import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { Clock } from '../../lib/clock.js';
import { badRequest } from '../../lib/errors.js';
import { getConfigVersion } from '../export-config/config-service.js';
import { RESULTS } from '../export-config/spec.js';
import { manualFileName } from '../grouping/grouping.js';
import type { Caller, Workspace } from '../tenancy/tenancy.js';
import { createJob } from './create-job.js';
import type { ExportJob } from './job-types.js';
import { narrow } from './selection.js';

const MAX_RANGE_DAYS = 31;

export const ManualExportSchema = z
  .object({
    /** Client-chosen id. Sending the same request twice creates only one job. */
    requestId: z.string().min(1).max(100),
    rangeStart: z.coerce.date(),
    rangeEnd: z.coerce.date(),
    sessionIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    results: z.array(z.enum(RESULTS)).min(1).optional(),
  })
  .strict()
  .refine((r) => r.rangeEnd > r.rangeStart, { message: 'rangeEnd must be after rangeStart', path: ['rangeEnd'] })
  .refine((r) => r.rangeEnd.getTime() - r.rangeStart.getTime() <= MAX_RANGE_DAYS * 86_400_000, {
    message: `Range can be at most ${MAX_RANGE_DAYS} days`,
    path: ['rangeEnd'],
  });
export type ManualExportRequest = z.infer<typeof ManualExportSchema>;

/**
 * A one-time export of a time range. It is a snapshot at request time: it uses the current
 * config version for columns and format, may only NARROW the data, and does not create
 * corrections or touch scheduled groups.
 */
export async function createManualExport(
  db: Db,
  caller: Caller,
  workspace: Workspace,
  request: ManualExportRequest,
  opts: { clock: Clock; cutoffSafetySeconds: number; maxAttempts: number },
): Promise<{ job: ExportJob; created: boolean }> {
  const config = await getConfigVersion(db, workspace.id);
  if (request.results && narrow(config.spec.filters.results, request.results)?.length === 0) {
    throw badRequest('The results filter does not overlap with the results allowed by the export config');
  }

  const existing = await findByRequestId(db, workspace.id, request.requestId);
  if (existing) return { job: existing, created: false };

  const now = opts.clock.now();
  try {
    const job = await withTransaction(db, (client) =>
      createJob(client, {
        tenantId: caller.tenantId,
        config,
        trigger: 'MANUAL',
        fileName: (id) => manualFileName(id, now),
        cutoff: new Date(now.getTime() - opts.cutoffSafetySeconds * 1000),
        rangeStart: request.rangeStart,
        rangeEnd: request.rangeEnd,
        extraFilters: { sessionIds: request.sessionIds, results: request.results },
        requestId: request.requestId,
        requestedBy: caller.userId,
        maxAttempts: opts.maxAttempts,
      }),
    );
    return { job, created: true };
  } catch (err) {
    // Two identical requests at the same moment: the unique key lets only one win.
    const winner = await findByRequestId(db, workspace.id, request.requestId);
    if (winner) return { job: winner, created: false };
    throw err;
  }
}

async function findByRequestId(db: Db, workspaceId: string, requestId: string): Promise<ExportJob | null> {
  const { rows } = await db.query<ExportJob>('SELECT * FROM export_job WHERE workspace_id = $1 AND request_id = $2', [
    workspaceId,
    requestId,
  ]);
  return rows[0] ?? null;
}
