import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { hourlySpec, SETTINGS, TestContext } from '../helpers/context.js';

let ctx: TestContext;
let app: ReturnType<typeof createApp>;
const asAcme = { 'x-tenant-id': 'tenant-a', 'x-user-id': 'alice' };
const asOther = { 'x-tenant-id': 'tenant-b', 'x-user-id': 'mallory' };

beforeEach(async () => {
  ctx = await TestContext.create();
  await ctx.workspace('ws-a', 'tenant-a');
  await ctx.workspace('ws-b', 'tenant-b');
  app = createApp({ db: ctx.db, storage: ctx.storage, clock: ctx.clock, settings: SETTINGS });
});
afterEach(async () => {
  await ctx.close();
});

describe('export settings API', () => {
  it('creates v1, saves edits as new versions and keeps old ones readable', async () => {
    const created = await request(app).post('/api/workspaces/ws-a/export-config').set(asAcme).send(hourlySpec());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ version: 1, currentVersion: 1 });

    const again = await request(app).post('/api/workspaces/ws-a/export-config').set(asAcme).send(hourlySpec());
    expect(again.status).toBe(409);

    const edited = await request(app)
      .put('/api/workspaces/ws-a/export-config')
      .set(asAcme)
      .send(hourlySpec({ name: 'renamed' }));
    expect(edited.body).toMatchObject({ version: 2, currentVersion: 2, spec: { name: 'renamed' } });

    const v1 = await request(app).get('/api/workspaces/ws-a/export-config?version=1').set(asAcme);
    expect(v1.body.spec.name).toBe('test hourly');
  });

  it('rejects invalid settings with readable errors', async () => {
    const res = await request(app)
      .post('/api/workspaces/ws-a/export-config')
      .set(asAcme)
      .send(hourlySpec({ timezone: 'Nowhere/City' }));
    expect(res.status).toBe(400);
    expect(res.body.issues[0].message).toBe('Unknown timezone "Nowhere/City"');
  });

  it('plans a schedule change for the next clean boundary instead of starting it now', async () => {
    await request(app).post('/api/workspaces/ws-a/export-config').set(asAcme).send(hourlySpec());
    ctx.clock.set(new Date('2026-11-11T10:20:00Z'));
    const halfHourly = hourlySpec({
      grouping: { groupBy: ['time_bucket(30m)'], closeWhen: { type: 'TIME', graceSeconds: 60 } },
    });

    const preview = await request(app).post('/api/workspaces/ws-a/export-config/preview').set(asAcme).send(halfHourly);
    expect(preview.body.groupingChangeAt).toBe('2026-11-11T11:00:00.000Z');

    const res = await request(app).put('/api/workspaces/ws-a/export-config').set(asAcme).send(halfHourly);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 2,
      effectiveFrom: '2026-11-11T11:00:00.000Z',
      groupingSince: '2026-11-11T11:00:00.000Z',
    });

    // Only one planned change at a time.
    const again = await request(app).put('/api/workspaces/ws-a/export-config').set(asAcme).send(hourlySpec());
    expect(again.status).toBe(400);
    expect(again.body.issues[0].message).toMatch(/already planned/);
  });

  it('refuses a schedule change whose time windows never line up', async () => {
    await request(app).post('/api/workspaces/ws-a/export-config').set(asAcme).send(hourlySpec());
    // UTC hours start at :00, Asia/Kolkata hours at :30 UTC: no common boundary.
    const res = await request(app)
      .put('/api/workspaces/ws-a/export-config')
      .set(asAcme)
      .send(hourlySpec({ timezone: 'Asia/Kolkata' }));
    expect(res.status).toBe(400);
    expect(res.body.issues[0].path).toEqual(['grouping']);
  });

  it('previews the first rows without delivering anything', async () => {
    await ctx.records('ws-a', [{ inspectedAt: '2026-11-11T09:00:00Z', id: 'p1', result: 'FAIL' }]);
    const res = await request(app)
      .post('/api/workspaces/ws-a/export-config/preview')
      .set(asAcme)
      .send(
        hourlySpec({
          columns: [
            { field: 'record_id', header: 'ID' },
            { field: 'result', valueMap: { FAIL: '0' } },
          ],
        }),
      );
    expect(res.body).toMatchObject({ headers: ['ID', 'result'], rows: [['p1', '0']] });
    expect(await ctx.jobs()).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('requires a caller and hides other tenants’ workspaces and exports (404, not 403)', async () => {
    expect((await request(app).get('/api/workspaces/ws-a/exports')).status).toBe(401);
    expect((await request(app).get('/api/workspaces/ws-a/exports').set(asOther)).status).toBe(404);

    await request(app).post('/api/workspaces/ws-a/export-config').set(asAcme).send(hourlySpec());
    const job = await request(app)
      .post('/api/workspaces/ws-a/exports')
      .set(asAcme)
      .send({ requestId: 'r1', rangeStart: '2026-11-11T09:00:00Z', rangeEnd: '2026-11-11T10:00:00Z' });

    expect((await request(app).get(`/api/exports/${job.body.id}`).set(asOther)).status).toBe(404);
    expect((await request(app).get(`/api/exports/${job.body.id}/file`).set(asOther)).status).toBe(404);
  });
});

describe('manual exports', () => {
  beforeEach(async () => {
    await request(app).post('/api/workspaces/ws-a/export-config').set(asAcme).send(hourlySpec());
    await ctx.records('ws-a', [
      { inspectedAt: '2026-11-11T08:10:00Z', id: 'm1', result: 'FAIL', sessionId: 'S-9' },
      { inspectedAt: '2026-11-11T08:20:00Z', id: 'm2', result: 'PASS', sessionId: 'S-9' },
      { inspectedAt: '2026-11-11T08:30:00Z', id: 'm3', result: 'FAIL', sessionId: 'S-8' },
    ]);
  });

  it('runs a narrowed snapshot export and serves the file', async () => {
    const body = {
      requestId: 'req-1',
      rangeStart: '2026-11-11T08:00:00Z',
      rangeEnd: '2026-11-11T09:00:00Z',
      results: ['FAIL'],
      sessionIds: ['S-9'],
    };
    const created = await request(app).post('/api/workspaces/ws-a/exports').set(asAcme).send(body);
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ trigger: 'MANUAL', status: 'PENDING', requestedBy: 'alice' });

    await ctx.pump();

    const detail = await request(app).get(`/api/exports/${created.body.id}`).set(asAcme);
    expect(detail.body).toMatchObject({
      status: 'COMPLETED',
      rowCount: 1,
      progress: { chunksTotal: 1, chunksDone: 1 },
    });
    expect(detail.body.file.sha256).toHaveLength(64);

    const file = await request(app).get(`/api/exports/${created.body.id}/file`).set(asAcme);
    expect(file.text).toBe('record_id,result,inspected_at\nm1,FAIL,2026-11-11T08:10:00Z\n');
  });

  it('creates one job when the same request is sent twice (even at the same time)', async () => {
    const body = { requestId: 'same', rangeStart: '2026-11-11T08:00:00Z', rangeEnd: '2026-11-11T09:00:00Z' };
    const send = () => request(app).post('/api/workspaces/ws-a/exports').set(asAcme).send(body);
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.body.id).toBe(b.body.id);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(await ctx.jobs()).toHaveLength(1);
  });

  it('lists exports and retries only FAILED ones', async () => {
    const created = await request(app)
      .post('/api/workspaces/ws-a/exports')
      .set(asAcme)
      .send({ requestId: 'r', rangeStart: '2026-11-11T08:00:00Z', rangeEnd: '2026-11-11T09:00:00Z' });
    const list = await request(app).get('/api/workspaces/ws-a/exports?trigger=MANUAL').set(asAcme);
    expect(list.body.items).toHaveLength(1);

    const retry = await request(app).post(`/api/exports/${created.body.id}/retry`).set(asAcme);
    expect(retry.status).toBe(409);
  });

  it('validates the time range', async () => {
    const res = await request(app)
      .post('/api/workspaces/ws-a/exports')
      .set(asAcme)
      .send({ requestId: 'r', rangeStart: '2026-11-11T09:00:00Z', rangeEnd: '2026-11-11T08:00:00Z' });
    expect(res.status).toBe(400);
  });
});

describe('fields', () => {
  it('lists the standard fields and the metadata keys the workspace really has', async () => {
    await ctx.records('ws-a', [
      { inspectedAt: '2026-11-11T09:00:00Z', metadata: { operator: 'op-1', torque_nm: 12 } },
      { inspectedAt: '2026-11-11T09:01:00Z', metadata: { operator: 'op-2' } },
    ]);
    await ctx.records('ws-b', [{ inspectedAt: '2026-11-11T09:00:00Z', metadata: { secret_b: 'x' } }]);

    const res = await request(app).get('/api/workspaces/ws-a/fields').set(asAcme);
    expect(res.body.standard).toContain('record_id');
    expect(res.body.metadata).toEqual([
      { key: 'operator', example: 'op-2', seen: 2, sampled: 2 },
      { key: 'torque_nm', example: '12', seen: 1, sampled: 2 },
    ]);
    expect(res.body.values).toMatchObject({
      inspection_type: ['surface'],
      result: ['PASS'],
      'metadata.operator': ['op-1', 'op-2'],
      'metadata.torque_nm': ['12'],
    });
    expect(res.body.values['metadata.secret_b']).toBeUndefined(); // other tenant's data never leaks
    expect(res.body.sample).toMatchObject({ metadata: { operator: 'op-2' }, result: 'PASS' });
  });
});

describe('field layout (display groups)', () => {
  const layout = {
    groups: [
      { id: 'g1', name: 'Machine data', fields: ['metadata.operator', 'metadata.torque_nm'] },
      { id: 'g2', name: 'When', fields: ['inspected_at'] },
    ],
  };

  it('starts with the default (null), then saves and returns the customer’s own groups', async () => {
    const before = await request(app).get('/api/workspaces/ws-a/field-layout').set(asAcme);
    expect(before.body.groups).toBeNull();

    const saved = await request(app).put('/api/workspaces/ws-a/field-layout').set(asAcme).send(layout);
    expect(saved.status).toBe(200);
    const after = await request(app).get('/api/workspaces/ws-a/field-layout').set(asAcme);
    expect(after.body).toMatchObject({ ...layout, updatedBy: 'alice' });
  });

  it('rejects a field in two groups, unknown fields, and other tenants', async () => {
    const twice = await request(app)
      .put('/api/workspaces/ws-a/field-layout')
      .set(asAcme)
      .send({
        groups: [
          { id: 'a', name: 'A', fields: ['result'] },
          { id: 'b', name: 'B', fields: ['result'] },
        ],
      });
    expect(twice.status).toBe(400);
    expect(twice.body.issues[0].message).toBe('"result" is in two groups');

    const unknown = await request(app)
      .put('/api/workspaces/ws-a/field-layout')
      .set(asAcme)
      .send({ groups: [{ id: 'a', name: 'A', fields: ['password'] }] });
    expect(unknown.status).toBe(400);

    const other = await request(app).put('/api/workspaces/ws-a/field-layout').set(asOther).send(layout);
    expect(other.status).toBe(404);
  });
});

describe('demo tools', () => {
  it('are off unless enabled', async () => {
    const res = await request(app).post('/api/workspaces/ws-a/demo/records').set(asAcme).send({ sessionId: 'D-1' });
    expect(res.status).toBe(404);
  });

  it('add finalized records to the caller’s own workspace only', async () => {
    const demoApp = createApp({
      db: ctx.db,
      storage: ctx.storage,
      clock: ctx.clock,
      settings: SETTINGS,
      demoTools: true,
    });
    const res = await request(demoApp)
      .post('/api/workspaces/ws-a/demo/records')
      .set(asAcme)
      .send({ sessionId: 'D-1', count: 5, minutesAgo: 30 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sessionId: 'D-1', added: 5, inspectedTo: '2026-11-11T09:30:00.000Z' });

    const other = await request(demoApp)
      .post('/api/workspaces/ws-a/demo/records')
      .set(asOther)
      .send({ sessionId: 'X' });
    expect(other.status).toBeGreaterThanOrEqual(403);
    const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM inspection_record');
    expect(rows[0].n).toBe(5);
  });
});
