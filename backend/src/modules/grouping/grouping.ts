import { DateTime } from 'luxon';

/**
 * Grouping helpers (D-13). A "partition" is one group of records exported together:
 * one time bucket (e.g. one hour) or one inspection session.
 */

export interface TimeWindow {
  start: Date;
  end: Date;
  /** Human readable key in the config timezone, e.g. 2026-11-11T10:00+05:30 */
  key: string;
}

/**
 * The time bucket that contains `instant`, using wall-clock time in `timezone`.
 * Buckets start at local midnight, so an hourly bucket in Asia/Kolkata starts at :30 UTC.
 */
export function windowContaining(instant: Date, bucketMinutes: number, timezone: string): TimeWindow {
  const local = DateTime.fromJSDate(instant).setZone(timezone);
  const dayStart = local.startOf('day');
  const minutesIntoDay = Math.floor(local.diff(dayStart, 'minutes').minutes);
  const start = dayStart.plus({ minutes: Math.floor(minutesIntoDay / bucketMinutes) * bucketMinutes });
  return toWindow(start, bucketMinutes);
}

/** The bucket right after `window`. */
export function nextWindow(window: TimeWindow, bucketMinutes: number, timezone: string): TimeWindow {
  return toWindow(DateTime.fromJSDate(window.end).setZone(timezone), bucketMinutes);
}

function toWindow(start: DateTime, bucketMinutes: number): TimeWindow {
  const end = start.plus({ minutes: bucketMinutes });
  return {
    start: start.toJSDate(),
    end: end.toJSDate(),
    key: start.toISO({ suppressMilliseconds: true, suppressSeconds: true }) ?? start.toString(),
  };
}

/**
 * Deterministic file name for a partition export. The same job always produces the
 * same name, so a retry overwrites instead of creating a second file.
 *   report_2026-11-11T1000+0530.csv
 *   report_S-102_correction_01.csv
 */
export function partitionFileName(partitionKey: string, correctionNo: number): string {
  const safeKey = partitionKey.replace(/[^A-Za-z0-9_+.-]/g, '');
  const suffix = correctionNo > 0 ? `_correction_${String(correctionNo).padStart(2, '0')}` : '';
  return `report_${safeKey}${suffix}.csv`;
}

export function manualFileName(jobId: string, createdAt: Date): string {
  const stamp = DateTime.fromJSDate(createdAt).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
  return `manual_${stamp}_${jobId.slice(0, 8)}.csv`;
}
