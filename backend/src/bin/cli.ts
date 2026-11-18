import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { migrate } from '../db/migrate.js';
import { addDemoRecords, DEMO, seedDemo } from '../demo/demo-data.js';
import { systemClock } from '../lib/clock.js';
import { handleSessionCompleted } from '../modules/events/session-events.js';
import { createManualExport } from '../modules/jobs/manual-export.js';
import { Scheduler } from '../modules/scheduler/scheduler.js';
import { printExport, printExports, waitForExport } from './cli-views.js';
import { createRuntime } from './runtime.js';

const HELP = `
Demo commands (Docker: docker compose exec api node dist/bin/cli.js <command> [options])

  seed                                   Create demo tenants, workspaces, records and the 2 configs
  tick                                   Run the scheduler once
  add-records   --workspace <id> --session <id> [--count 20]
                                         Add new finalized records (inspected now)
  add-late      --workspace <id> --minutes-ago <n> [--session <id>] [--count 3]
                                         Add records inspected in the past but finalized now
                                         (they appear in a correction file)
  complete-session --workspace <id> --session <id> [--event-id <id>]
                                         Send a session.completed event (sending it twice is safe)
  export        --workspace <id> [--hours 24] [--results FAIL,REVIEW] [--wait]
                                         Start a one-time export of the last N hours (--wait: follow it)
  exports       --workspace <id>         List the newest exports as a table
  show          --id <export id>         One export: status, rows, file, every chunk with its attempts
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string' },
    session: { type: 'string' },
    count: { type: 'string' },
    'minutes-ago': { type: 'string' },
    'event-id': { type: 'string' },
    id: { type: 'string' },
    hours: { type: 'string' },
    results: { type: 'string' },
    wait: { type: 'boolean' },
  },
});

const { env, db, logger } = createRuntime();
const command = positionals[0];

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== 'string') throw new Error(`--${name} is required`);
  return value;
}

try {
  switch (command) {
    case 'seed': {
      await migrate(db);
      const { created } = await seedDemo(db, new Date());
      console.log(created ? 'Demo data created.' : 'Demo data already exists.');
      console.log(
        `Tenants/workspaces:\n  ${DEMO.acme.tenantId} / ${DEMO.acme.workspaceId} (hourly)\n  ${DEMO.globex.tenantId} / ${DEMO.globex.workspaceId} (per session)`,
      );
      break;
    }
    case 'tick': {
      const scheduler = new Scheduler({
        db,
        clock: systemClock,
        logger,
        settings: { cutoffSafetySeconds: env.CUTOFF_SAFETY_SECONDS, maxAttempts: env.TASK_MAX_ATTEMPTS },
      });
      console.log(await scheduler.tick());
      break;
    }
    case 'add-records':
    case 'add-late': {
      const result = await addDemoRecords(
        db,
        required('workspace'),
        {
          sessionId: values.session ?? `LATE-${randomUUID().slice(0, 6)}`,
          count: Number(values.count ?? (command === 'add-late' ? 3 : 20)),
          minutesAgo: command === 'add-late' ? Number(required('minutes-ago')) : 0,
        },
        new Date(),
        env.CUTOFF_SAFETY_SECONDS,
      );
      console.log(`Inserted ${result.added} records into ${values.workspace} / ${result.sessionId}`);
      break;
    }
    case 'complete-session': {
      const outcome = await handleSessionCompleted(
        db,
        {
          eventId: values['event-id'] ?? `evt-${randomUUID()}`,
          type: 'session.completed',
          workspaceId: required('workspace'),
          sessionId: required('session'),
          occurredAt: new Date(),
        },
        systemClock,
      );
      console.log(`Event outcome: ${outcome}`);
      break;
    }
    case 'export': {
      const workspaceId = required('workspace');
      const { rows } = await db.query<{ id: string; tenant_id: string; name: string }>(
        'SELECT id, tenant_id, name FROM workspace WHERE id = $1',
        [workspaceId],
      );
      const ws = rows[0];
      if (!ws) throw new Error(`Unknown workspace ${workspaceId}`);
      const hours = Number(values.hours ?? 24);
      const now = new Date();
      const { job } = await createManualExport(
        db,
        { tenantId: ws.tenant_id, userId: 'cli' },
        { id: ws.id, tenantId: ws.tenant_id, name: ws.name },
        {
          requestId: `cli-${randomUUID().slice(0, 8)}`,
          rangeStart: new Date(now.getTime() - hours * 3_600_000),
          rangeEnd: now,
          results: values.results ? (values.results.split(',') as ('PASS' | 'FAIL' | 'REVIEW')[]) : undefined,
        },
        { clock: systemClock, cutoffSafetySeconds: env.CUTOFF_SAFETY_SECONDS, maxAttempts: env.TASK_MAX_ATTEMPTS },
      );
      console.log(`Started one-time export ${job.id} (last ${hours} h) -> ${job.file_name}`);
      if (values.wait) {
        await waitForExport(db, job.id);
        console.log('');
        await printExport(db, job.id);
      } else {
        console.log(`Follow it: docker compose exec api node dist/bin/cli.js show --id ${job.id}`);
      }
      break;
    }
    case 'exports':
      await printExports(db, required('workspace'));
      break;
    case 'show':
      await printExport(db, required('id'));
      break;
    default:
      console.log(HELP);
  }
} finally {
  await db.end();
}
