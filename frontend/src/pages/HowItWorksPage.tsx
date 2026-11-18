import { Link } from 'react-router-dom';

/** A plain-English tour of the export pipeline, linked to the screens that show each part. */

const STEPS = [
  {
    title: 'Customer settings',
    who: 'API · export_config_version',
    text: 'Each customer fills in a settings form: which columns, renamed values, date format, timezone, filters and when to send files. Every save makes a new, frozen version.',
    link: { to: '/settings', label: 'See the settings' },
  },
  {
    title: 'A group closes',
    who: 'Scheduler',
    text: 'Records are grouped into "partitions": one hour (Acme) or one session (Globex). When the hour ends (+ grace time) or the session.completed event arrives (+ settle time), the group is ready.',
  },
  {
    title: 'An export job is created',
    who: 'Scheduler → PostgreSQL',
    text: 'In ONE database transaction: the job, its chunk tasks (fixed row ranges), a finalize task and an outbox row. Either all of it is saved or nothing is.',
  },
  {
    title: 'Tasks go to the queue',
    who: 'Dispatcher → Redis (BullMQ)',
    text: 'The dispatcher reads the outbox and puts task ids on the queue. The queue only carries ids; the real state stays in PostgreSQL.',
  },
  {
    title: 'Workers write chunks',
    who: 'Workers (3 containers × 4)',
    text: 'A worker claims a task (takes a time-limited lease), reads its rows, formats them with the spec and writes a chunk file. Many chunks run in parallel.',
  },
  {
    title: 'The file is published',
    who: 'Worker (finalize task)',
    text: 'When all chunks are done, the finalize task joins them into one CSV, writes it to a temp file and renames it into place, so the customer never sees half a file.',
    link: { to: '/reports', label: 'See the reports' },
  },
];

const FAILURES = [
  [
    'A worker crashes in the middle of a chunk',
    'Its lease runs out. The reconciler puts the task back to READY and another worker redoes only that chunk.',
  ],
  [
    'A slow worker wakes up after someone else redid its task',
    'Its save is rejected: the attempt number no longer matches ("fencing"). No double rows.',
  ],
  ['A chunk fails with a temporary error', 'It waits (2s, 4s, 8s… with jitter) and tries again, up to 3 attempts.'],
  [
    'It still fails after 3 attempts',
    'The export is marked FAILED. You can press "Retry" on its page; it continues on the same config version.',
  ],
  [
    'A queue message is lost or sent twice',
    'The database is the truth. Lost messages are sent again by the reconciler; duplicates are ignored by the claim step.',
  ],
  [
    'A record arrives late (offline tablet)',
    'The next scheduler run sends it in a small correction file (…_correction_01.csv) with only the new rows.',
  ],
];

export function HowItWorksPage() {
  return (
    <div className="stack">
      <section>
        <h1>How an export works</h1>
        <p className="lead">
          A look behind the scenes, for engineers and reviewers. This UI shows one workflow from the assignment:{' '}
          <strong>a CSV report delivered on a schedule</strong>, for two customers with different settings. The same
          code serves both; only their config is different.
        </p>
      </section>

      <section className="flow">
        {STEPS.map((step, i) => (
          <div className="flow-step" key={step.title}>
            <div className="flow-number">{i + 1}</div>
            <div>
              <h3>{step.title}</h3>
              <div className="muted small">{step.who}</div>
              <p>{step.text}</p>
              {step.link && <Link to={step.link.to}>{step.link.label} →</Link>}
            </div>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Which records go into a file?</h2>
        <p>
          Every export has a <strong>cutoff</strong> time. A file contains the records of its group that were finalized{' '}
          <em>after the previous cutoff</em> and <em>up to this cutoff</em>. The first file of a group has no previous
          cutoff. A correction file starts where the last one stopped. This is why every record lands in exactly one
          file.
        </p>
        <pre className="diagram">
          {`  original file          correction 01          correction 02
 ─────────────────┤ ───────────────────┤ ───────────────────┤
              cutoff 1               cutoff 2               cutoff 3`}
        </pre>
      </section>

      <section className="panel">
        <h2>What happens when something fails</h2>
        <table>
          <thead>
            <tr>
              <th>Problem</th>
              <th>What the platform does</th>
            </tr>
          </thead>
          <tbody>
            {FAILURES.map(([problem, answer]) => (
              <tr key={problem}>
                <td>{problem}</td>
                <td>{answer}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">More detail: docs/reliability.md in the repository.</p>
      </section>

      <section className="panel">
        <h2>Try it yourself</h2>
        <ol className="try-list">
          <li>
            Open <Link to="/reports">Reports</Link>. Acme has one file per hour. Open one to see its file, and expand
            “Technical details” for its chunks and attempts.
          </li>
          <li>
            Open <Link to="/demo">Demo tools</Link> and add records “1 hour ago”. A <strong>Late records update</strong>{' '}
            appears within ~10 seconds; the earlier file is not changed.
          </li>
          <li>
            Switch to <strong>Globex</strong> (top right). In <Link to="/demo">Demo tools</Link>, add records to a
            session and press “Finish session”. After the settle time (10 s) its report appears. Press it again with the
            same event id: nothing new happens.
          </li>
          <li>
            In <Link to="/settings">Settings</Link>, add an extra field, rename a column or change how a value is shown
            (e.g. FAIL → Rejected). The preview updates at once: the output changes, the code does not.
          </li>
          <li>
            In <Link to="/new-export">New export</Link>, start a <strong>one-time export</strong> for a time range. The
            same request id twice gives back the same export.
          </li>
          <li>
            Crash recovery: run <code>docker compose kill worker</code> while an export runs, then{' '}
            <code>docker compose up -d --scale worker=3</code>. The export finishes; its technical details show the
            retried attempt.
          </li>
        </ol>
      </section>

      <section className="panel">
        <h2>Real vs simulated in this demo</h2>
        <ul>
          <li>
            <strong>Simulated destination:</strong> files go to a local folder (<code>/data</code> in Docker), not S3 or
            SFTP.
          </li>
          <li>
            <strong>Simulated login:</strong> the workspace picker sets an <code>x-tenant-id</code> header.
          </li>
          <li>
            <strong>Simulated source data:</strong> inspection records and “session completed” events come from seeded
            demo data and the Demo tools page, not a real inspection app.
          </li>
          <li>
            <strong>Real:</strong> PostgreSQL, Redis/BullMQ queue, parallel workers, leases, retries, corrections.
          </li>
        </ul>
      </section>
    </div>
  );
}
