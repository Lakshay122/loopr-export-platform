import type { ExportSummary, JobStatus } from '../api/types';

/** Customer-friendly words for the API's technical values. */

export const STATUS_LABEL: Record<JobStatus, string> = {
  PENDING: 'Waiting',
  RUNNING: 'In progress',
  COMPLETED: 'Delivered',
  FAILED: 'Failed',
};

export function kindLabel(job: ExportSummary): string {
  if (job.trigger === 'MANUAL') return 'One-time export';
  if (job.trigger === 'CORRECTION') return `Late records update #${job.correctionNo ?? 1}`;
  return job.sessionId ? 'Session report' : 'Scheduled report';
}

/** What period or session a report covers, e.g. "12 Nov, 14:00 – 15:00" or "Session GLX-S-3". */
export function periodLabel(job: ExportSummary): string {
  if (job.sessionId) return `Session ${job.sessionId}`;
  if (!job.rangeStart || !job.rangeEnd) return '—';
  const start = new Date(job.rangeStart);
  const end = new Date(job.rangeEnd);
  const sameDay = start.toDateString() === new Date(end.getTime() - 1).toDateString();
  return sameDay
    ? `${formatDate(start)}, ${formatClock(start)} – ${formatClock(end)}`
    : `${formatDate(start)} ${formatClock(start)} – ${formatDate(end)} ${formatClock(end)}`;
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false,
  });
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return formatTime(iso);
}

export function duration(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return 'under a second';
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  return `${Math.round(ms / 60_000)} minutes`;
}

export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
