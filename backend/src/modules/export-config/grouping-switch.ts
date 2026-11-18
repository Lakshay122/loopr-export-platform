import { ZodError } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { windowContaining } from '../grouping/grouping.js';
import { groupingOf, type ExportSpec, type Grouping } from './spec.js';

/**
 * Changing the schedule type (hourly <-> per session, or the bucket size / timezone of time
 * buckets) without gaps or duplicates.
 *
 * The rule: a change never starts "now". It starts at the next clean boundary, `effective_from`:
 * - hourly -> per session: the end of the current hour. That hour is still sent as an hourly file.
 *   From then on, each session file holds only records inspected at or after the boundary.
 * - per session -> hourly: the start of the next hour. Sessions still open at that moment get a
 *   session file with their records from before the boundary; the rest goes into hourly files.
 * - one time bucket -> another: the first moment that is a boundary in both (e.g. 1h -> 30m: next hour).
 *
 * So every record lands in exactly one group, and files already sent never change.
 * Each run of versions with the same grouping is an "era": [from, to).
 */

/** Two specs with the same key group records the same way. */
export function groupingKey(spec: ExportSpec): string {
  const g = groupingOf(spec);
  return g.kind === 'TIME' ? `TIME/${g.bucketMinutes}/${spec.timezone}` : 'SESSION';
}

export interface GroupingEra {
  grouping: Grouping;
  /** The newest spec of the era (grouping and timezone are the same for the whole era). */
  spec: ExportSpec;
  /** null = since the config was created */
  from: Date | null;
  /** null = still current */
  to: Date | null;
}

/** All grouping eras of a config, oldest first. There are only as many as schedule changes. */
export async function groupingEras(db: Queryable, configId: string): Promise<GroupingEra[]> {
  const { rows } = await db.query<{ spec: ExportSpec; effective_from: Date | null }>(
    'SELECT spec, effective_from FROM export_config_version WHERE config_id = $1 ORDER BY version',
    [configId],
  );
  const eras: (GroupingEra & { key: string })[] = [];
  for (const row of rows) {
    const key = groupingKey(row.spec);
    const last = eras.at(-1);
    if (last && last.key === key) {
      last.spec = row.spec;
      continue;
    }
    const from = last ? row.effective_from : null;
    if (last) last.to = from;
    eras.push({ key, grouping: groupingOf(row.spec), spec: row.spec, from, to: null });
  }
  return eras.map(({ key: _key, ...era }) => era);
}

/**
 * When a change from `before` to `after` would start, or null if the grouping does not change.
 * Throws a validation error if it cannot be done safely.
 */
export async function planGroupingChange(
  db: Queryable,
  configId: string,
  before: ExportSpec,
  after: ExportSpec,
  now: Date,
): Promise<Date | null> {
  if (groupingKey(before) === groupingKey(after)) return null;

  const current = (await groupingEras(db, configId)).at(-1);
  if (current?.from && current.from > now) {
    throw settingError(
      `A schedule change is already planned for ${current.from.toISOString()}. You can change it again after it starts.`,
    );
  }
  return switchTime(before, after, now);
}

/** The first clean boundary after `now` where `after` can take over from `before`. */
export function switchTime(before: ExportSpec, after: ExportSpec, now: Date): Date {
  const from = groupingOf(before);
  const to = groupingOf(after);

  if (from.kind === 'SESSION') {
    if (to.kind === 'SESSION') throw new Error('No grouping change');
    return windowContaining(now, to.bucketMinutes, after.timezone).end;
  }

  // Walk the current time windows until one ends on a boundary of the new grouping.
  let end = windowContaining(now, from.bucketMinutes, before.timezone).end;
  const limit = now.getTime() + 2 * 86_400_000;
  while (end.getTime() <= limit) {
    if (to.kind === 'SESSION') return end;
    if (windowContaining(end, to.bucketMinutes, after.timezone).start.getTime() === end.getTime()) return end;
    end = windowContaining(end, from.bucketMinutes, before.timezone).end;
  }
  throw settingError(
    'The old and new time windows never line up, so files would overlap. Please contact support for this change.',
  );
}

function settingError(message: string): ZodError {
  return new ZodError([{ code: 'custom', path: ['grouping'], message }]);
}
