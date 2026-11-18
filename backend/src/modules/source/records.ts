import type { Queryable } from '../../db/pool.js';

/** One inspection record as read from the source platform. */
export interface SourceRecord {
  record_id: string;
  session_id: string;
  part_serial: string;
  inspection_type: string;
  result: string;
  defect: string | null;
  image_ref: string | null;
  inspected_at: Date;
  finalized_at: Date;
  /** Customer-specific extra fields. Keys differ per customer and per record. */
  metadata: Record<string, unknown>;
}

/**
 * Which records a job exports. Fixed when the job is created, so a retry reads the same rows.
 *
 * Finalized-time rule (D-08): prevCutoff < finalized_at <= cutoff.
 * The left side is open and the right side is closed, so a record exactly on a cutoff
 * belongs to exactly one job.
 */
export interface Selection {
  workspaceId: string;
  cutoff: Date;
  prevCutoff?: Date | null;
  /** inspected_at in [rangeStart, rangeEnd) */
  rangeStart?: Date | null;
  rangeEnd?: Date | null;
  sessionIds?: string[] | null;
  results?: string[] | null;
  inspectionTypes?: string[] | null;
  /** metadata key -> allowed values */
  metadata?: Record<string, string[]> | null;
}

/**
 * Position in the (inspected_at, id) sort order. `at` is kept as PostgreSQL text so
 * microsecond precision survives the round trip (a JS Date only keeps milliseconds).
 */
export interface Cursor {
  at: string;
  id: string;
}

/** Builds the WHERE clause for a selection. Params are appended to `params`. */
function whereClause(sel: Selection, params: unknown[]): string {
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const parts = [
    `r.workspace_id = ${add(sel.workspaceId)}`,
    `r.finalized_at IS NOT NULL`,
    `r.finalized_at <= ${add(sel.cutoff)}`,
  ];
  if (sel.prevCutoff) parts.push(`r.finalized_at > ${add(sel.prevCutoff)}`);
  if (sel.rangeStart) parts.push(`r.inspected_at >= ${add(sel.rangeStart)}`);
  if (sel.rangeEnd) parts.push(`r.inspected_at < ${add(sel.rangeEnd)}`);
  if (sel.sessionIds?.length) parts.push(`r.session_id = ANY(${add(sel.sessionIds)})`);
  if (sel.results?.length) parts.push(`r.result = ANY(${add(sel.results)})`);
  if (sel.inspectionTypes?.length) parts.push(`r.inspection_type = ANY(${add(sel.inspectionTypes)})`);
  for (const [key, values] of Object.entries(sel.metadata ?? {})) {
    parts.push(`r.metadata ->> ${add(key)} = ANY(${add(values)})`);
  }
  return parts.join(' AND ');
}

const RECORD_COLUMNS = `
  r.id AS record_id, r.session_id, r.part_serial, r.inspection_type, r.result,
  r.defect, r.image_ref, r.inspected_at, r.finalized_at, r.metadata,
  r.inspected_at::text AS cursor_at`;

/**
 * Reads one page of records after `after` and up to `upTo` (inclusive), in stable order.
 * Keyset paging: memory stays small and pages never shift when new rows arrive.
 */
export async function readPage(
  db: Queryable,
  sel: Selection,
  range: { after: Cursor | null; upTo: Cursor | null },
  limit: number,
): Promise<{ records: SourceRecord[]; last: Cursor | null }> {
  const params: unknown[] = [];
  let where = whereClause(sel, params);
  if (range.after) {
    params.push(range.after.at, range.after.id);
    where += ` AND (r.inspected_at, r.id) > ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  if (range.upTo) {
    params.push(range.upTo.at, range.upTo.id);
    where += ` AND (r.inspected_at, r.id) <= ($${params.length - 1}::timestamptz, $${params.length})`;
  }
  params.push(limit);

  const { rows } = await db.query<SourceRecord & { cursor_at: string }>(
    `SELECT ${RECORD_COLUMNS} FROM inspection_record r
     WHERE ${where}
     ORDER BY r.inspected_at, r.id
     LIMIT $${params.length}`,
    params,
  );

  const lastRow = rows.at(-1);
  return {
    records: rows.map(({ cursor_at: _ignored, ...record }) => record),
    last: lastRow ? { at: lastRow.cursor_at, id: lastRow.record_id } : null,
  };
}

/**
 * Splits the selection into chunks of about `chunkSize` rows.
 * Returns the upper cursor of each full chunk; the last chunk is open-ended.
 */
export async function chunkBoundaries(db: Queryable, sel: Selection, chunkSize: number): Promise<Cursor[]> {
  const params: unknown[] = [];
  const where = whereClause(sel, params);
  params.push(chunkSize);
  const { rows } = await db.query<Cursor>(
    `SELECT at, id FROM (
       SELECT r.inspected_at::text AS at, r.id, r.inspected_at,
              row_number() OVER (ORDER BY r.inspected_at, r.id) AS n
       FROM inspection_record r
       WHERE ${where}
     ) numbered
     WHERE n % $${params.length} = 0
     ORDER BY inspected_at, id`,
    params,
  );
  return rows;
}

/** True if at least one record matches. Used to decide if a correction file is needed. */
export async function hasRecords(db: Queryable, sel: Selection): Promise<boolean> {
  const params: unknown[] = [];
  const { rows } = await db.query(
    `SELECT 1 FROM inspection_record r WHERE ${whereClause(sel, params)} LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

/** IDs of matching records. Used to flag late records beyond the lookback window. */
export async function recordIds(db: Queryable, sel: Selection, limit: number): Promise<string[]> {
  const params: unknown[] = [];
  const where = whereClause(sel, params);
  params.push(limit);
  const { rows } = await db.query<{ id: string }>(
    `SELECT r.id FROM inspection_record r WHERE ${where} ORDER BY r.id LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => r.id);
}

/** Latest finalized records for the settings preview. */
export async function latestRecords(db: Queryable, sel: Selection, limit: number): Promise<SourceRecord[]> {
  const params: unknown[] = [];
  const where = whereClause(sel, params);
  params.push(limit);
  const { rows } = await db.query<SourceRecord & { cursor_at: string }>(
    `SELECT ${RECORD_COLUMNS} FROM inspection_record r WHERE ${where}
     ORDER BY r.inspected_at DESC, r.id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(({ cursor_at: _ignored, ...record }) => record);
}

export interface MetadataKey {
  key: string;
  /** A recent value, to show the customer what the field looks like. */
  example: string;
  /** How many of the sampled records have this key. */
  seen: number;
  sampled: number;
}

/**
 * Which metadata keys a workspace's records actually have, from its newest records.
 * Lets the settings screen offer customer-specific fields without anyone typing JSON.
 */
export async function metadataKeys(db: Queryable, workspaceId: string, sample = 1000): Promise<MetadataKey[]> {
  const { rows } = await db.query<MetadataKey>(
    `WITH recent AS (
       SELECT metadata, inspected_at FROM inspection_record
       WHERE workspace_id = $1 ORDER BY inspected_at DESC LIMIT $2
     )
     SELECT k.key,
            (array_agg(k.value ORDER BY r.inspected_at DESC))[1] AS example,
            count(*)::int AS seen,
            (SELECT count(*)::int FROM recent) AS sampled
     FROM recent r, jsonb_each_text(r.metadata) k
     GROUP BY k.key
     ORDER BY seen DESC, k.key
     LIMIT 50`,
    [workspaceId, sample],
  );
  return rows;
}

/** At most this many different values are listed for a field; more means "free text" (e.g. serial numbers). */
const MAX_LISTED_VALUES = 20;

/**
 * The values that really occur in a workspace's newest records, per field, most common first.
 * `null` = too many different values to list. Lets the customer rename "weld" by picking it
 * from a list instead of guessing what to type.
 */
export async function fieldValues(
  db: Queryable,
  workspaceId: string,
  sample = 1000,
): Promise<Record<string, string[] | null>> {
  const { rows } = await db.query<{ field: string; value: string; n: number }>(
    `WITH recent AS (
       SELECT inspection_type, defect, result, metadata FROM inspection_record
       WHERE workspace_id = $1 ORDER BY inspected_at DESC LIMIT $2
     )
     SELECT field, value, count(*)::int AS n FROM (
       SELECT 'inspection_type' AS field, inspection_type AS value FROM recent
       UNION ALL SELECT 'defect', defect FROM recent WHERE defect IS NOT NULL
       UNION ALL SELECT 'result', result FROM recent
       UNION ALL SELECT 'metadata.' || k.key, k.value FROM recent, jsonb_each_text(recent.metadata) k
     ) v
     GROUP BY field, value
     ORDER BY field, n DESC, value`,
    [workspaceId, sample],
  );
  const result: Record<string, string[] | null> = {};
  for (const { field, value } of rows) {
    const list = result[field];
    if (list === null) continue;
    if (!list) result[field] = [value];
    else if (list.length >= MAX_LISTED_VALUES) result[field] = null;
    else list.push(value);
  }
  return result;
}
