import type { Queryable } from '../../db/pool.js';
import { formatRecord, headerLine, recordLine } from '../csv/csv-format.js';
import { latestRecords } from '../source/records.js';
import { getConfigVersion } from './config-service.js';
import { planGroupingChange } from './grouping-switch.js';
import { parseSpec } from './spec.js';

export interface Preview {
  headers: string[];
  rows: string[][];
  csv: string;
  /** Set when saving would change the schedule type: the moment the change would start. */
  groupingChangeAt: Date | null;
}

/**
 * Validates a spec and shows the first rows the CSV would contain. Delivers nothing.
 * Also checks a schedule change the same way saving would, and says when it would start.
 */
export async function previewExport(
  db: Queryable,
  workspaceId: string,
  specInput: unknown,
  now: Date,
  limit = 10,
): Promise<Preview> {
  const spec = parseSpec(specInput);
  const current = await getConfigVersion(db, workspaceId).catch(() => null);
  const groupingChangeAt = current ? await planGroupingChange(db, current.configId, current.spec, spec, now) : null;
  const records = await latestRecords(
    db,
    {
      workspaceId,
      cutoff: now,
      results: spec.filters.results ?? null,
      inspectionTypes: spec.filters.inspectionTypes ?? null,
      metadata: spec.filters.metadata ?? null,
    },
    limit,
  );
  return {
    headers: spec.columns.map((c) => c.header ?? c.field),
    rows: records.map((r) => formatRecord(r, spec)),
    csv: headerLine(spec) + records.map((r) => recordLine(r, spec)).join(''),
    groupingChangeAt,
  };
}
