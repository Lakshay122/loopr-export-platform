import type { Db } from '../db/pool.js';
import { getArtifact, getJob, listJobs, listTasks } from '../modules/jobs/job-queries.js';
import type { ExportJob } from '../modules/jobs/job-types.js';

/** Plain-text views for the demo CLI, so nobody has to read raw JSON in a terminal. */

/** Prints rows as aligned columns. */
export function table(headers: string[], rows: (string | number | null)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map((c) => (c === null ? '-' : String(c))))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)));
  return cells
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const time = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 19) + 'Z' : null);

export async function printExports(db: Db, workspaceId: string): Promise<void> {
  const jobs = await listJobs(db, workspaceId, { limit: 20 });
  if (jobs.length === 0) {
    console.log(`No exports yet for ${workspaceId}.`);
    return;
  }
  console.log(
    table(
      ['Created (UTC)', 'Type', 'Status', 'Rows', 'File', 'Id'],
      jobs.map((j) => [time(j.created_at), j.trigger, j.status, j.row_count, j.file_name, j.id]),
    ),
  );
  console.log(`\nDetails of one export: docker compose exec api node dist/bin/cli.js show --id <Id>`);
}

export async function printExport(db: Db, jobId: string): Promise<ExportJob> {
  const [job, tasks, artifact] = await Promise.all([getJob(db, jobId), listTasks(db, jobId), getArtifact(db, jobId)]);
  console.log(`Export ${job.id}`);
  const facts: [string, string | number | null][] = [
    ['Type', job.trigger + (job.correction_no ? ` (correction #${job.correction_no})` : '')],
    ['Status', job.status],
    ['Settings version', job.config_version],
    ['Rows', job.row_count],
    ['File', artifact ? artifact.location : job.file_name],
    ['SHA-256', artifact?.sha256 ?? null],
    ['Error', job.error],
  ];
  for (const [label, value] of facts) console.log(`  ${label.padEnd(17)} ${value ?? '-'}`);
  console.log('\nParts (each chunk runs on any worker; finalize joins them into one file):');
  console.log(
    table(
      ['Part', 'Status', 'Attempts', 'Rows', 'Last worker', 'Last error'],
      tasks.map((t) => [
        t.kind === 'CHUNK' ? `chunk ${t.seq}` : 'finalize',
        t.status,
        `${t.attempt}/${t.max_attempts}`,
        t.row_count,
        t.worker_id,
        t.last_error,
      ]),
    ),
  );
  const retried = tasks.filter((t) => t.attempt > 1);
  if (retried.length) {
    console.log(
      `\n${retried.length} part(s) needed more than one attempt (for example after a worker crash). ` +
        'Each part was still saved exactly once.',
    );
  }
  return job;
}

/** Waits until an export is COMPLETED or FAILED (or the time is up), printing progress. */
export async function waitForExport(db: Db, jobId: string, timeoutMs = 10 * 60_000): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const [job, tasks] = await Promise.all([getJob(db, jobId), listTasks(db, jobId)]);
    const done = tasks.filter((t) => t.kind === 'CHUNK' && t.status === 'SUCCEEDED').length;
    const total = tasks.filter((t) => t.kind === 'CHUNK').length;
    const line = `${job.status}: ${done}/${total} chunks done`;
    if (line !== last) console.log(`  ${time(new Date())}  ${line}`);
    last = line;
    if (job.status === 'COMPLETED' || job.status === 'FAILED') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('  Still running; check again later with the show command.');
}
