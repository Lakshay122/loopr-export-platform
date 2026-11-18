import express from 'express';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import type { Clock } from '../lib/clock.js';
import { addDemoRecords, DemoRecordsSchema } from '../demo/demo-data.js';
import { notFound } from '../lib/errors.js';
import {
  createConfig,
  getConfigVersion,
  updateConfig,
  type ConfigVersion,
} from '../modules/export-config/config-service.js';
import { groupingEras } from '../modules/export-config/grouping-switch.js';
import { previewExport } from '../modules/export-config/preview.js';
import { getFieldLayout, saveFieldLayout } from '../modules/field-layout/field-layout.js';
import { EXPORT_FIELDS } from '../modules/export-config/spec.js';
import { fieldValues, latestRecords, metadataKeys } from '../modules/source/records.js';
import { handleSessionCompleted, SessionCompletedSchema } from '../modules/events/session-events.js';
import { getArtifact, getJobForTenant, listJobs, listTasks } from '../modules/jobs/job-queries.js';
import { createManualExport, ManualExportSchema } from '../modules/jobs/manual-export.js';
import { retryJob } from '../modules/jobs/retry-job.js';
import type { LocalStorage } from '../modules/storage/local-storage.js';
import { requireWorkspace } from '../modules/tenancy/tenancy.js';
import { configDto, jobDetailDto, jobSummaryDto } from './dto.js';
import { authenticate, callerOf, errorHandler } from './http.js';

export interface AppDeps {
  db: Db;
  storage: LocalStorage;
  clock: Clock;
  settings: { cutoffSafetySeconds: number; maxAttempts: number };
  /** Demo only: allow adding fake inspection records through the API. */
  demoTools?: boolean;
}

const ListQuery = z.object({
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']).optional(),
  trigger: z.enum(['SCHEDULED', 'CORRECTION', 'MANUAL']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const VersionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

/** HTTP API (D-14). Thin handlers: validate input, check tenant access, call a module. */
export function createApp(deps: AppDeps): express.Express {
  const { db, storage, clock, settings } = deps;
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Internal: source events from the inspection platform. Production: a Kafka / Event Hubs consumer.
  app.post('/internal/events', async (req, res) => {
    const event = SessionCompletedSchema.parse(req.body);
    const outcome = await handleSessionCompleted(db, event, clock);
    res.status(202).json({ outcome });
  });

  const api = express.Router();
  api.use(authenticate);

  // ---- Demo only: fake inspection records (stands in for the inspection platform) ----
  if (deps.demoTools) {
    api.post('/workspaces/:workspaceId/demo/records', async (req, res) => {
      const ws = await requireWorkspace(db, callerOf(res), req.params.workspaceId);
      const request = DemoRecordsSchema.parse(req.body);
      res.status(201).json(await addDemoRecords(db, ws.id, request, clock.now(), settings.cutoffSafetySeconds));
    });
  }

  // ---- Export settings ----
  const withGroupingSince = async (config: ConfigVersion) =>
    configDto(config, (await groupingEras(db, config.configId)).at(-1)?.from ?? null);

  api.get('/workspaces/:workspaceId/export-config', async (req, res) => {
    const ws = await requireWorkspace(db, callerOf(res), req.params.workspaceId);
    const { version } = VersionQuery.parse(req.query);
    res.json(await withGroupingSince(await getConfigVersion(db, ws.id, version)));
  });

  api.post('/workspaces/:workspaceId/export-config', async (req, res) => {
    const caller = callerOf(res);
    const ws = await requireWorkspace(db, caller, req.params.workspaceId);
    res.status(201).json(configDto(await createConfig(db, ws.id, req.body, caller.userId, clock.now())));
  });

  api.put('/workspaces/:workspaceId/export-config', async (req, res) => {
    const caller = callerOf(res);
    const ws = await requireWorkspace(db, caller, req.params.workspaceId);
    res.json(await withGroupingSince(await updateConfig(db, ws.id, req.body, caller.userId, clock.now())));
  });

  // Which fields can be exported: the standard ones plus the metadata keys this workspace's records have,
  // and the values each field really takes (for "change values" in the settings screen).
  api.get('/workspaces/:workspaceId/fields', async (req, res) => {
    const ws = await requireWorkspace(db, callerOf(res), req.params.workspaceId);
    const [metadata, values, [sample]] = await Promise.all([
      metadataKeys(db, ws.id),
      fieldValues(db, ws.id),
      latestRecords(db, { workspaceId: ws.id, cutoff: clock.now() }, 1),
    ]);
    // `sample`: the newest record as it is stored, so the customer sees what one record contains.
    res.json({ standard: EXPORT_FIELDS, metadata, values, sample: sample ?? null });
  });

  // How this workspace groups its fields on the settings screen (display only).
  api.get('/workspaces/:workspaceId/field-layout', async (req, res) => {
    const ws = await requireWorkspace(db, callerOf(res), req.params.workspaceId);
    res.json(await getFieldLayout(db, ws.id));
  });

  api.put('/workspaces/:workspaceId/field-layout', async (req, res) => {
    const caller = callerOf(res);
    const ws = await requireWorkspace(db, caller, req.params.workspaceId);
    res.json(await saveFieldLayout(db, ws.id, req.body, caller.userId));
  });

  api.post('/workspaces/:workspaceId/export-config/preview', async (req, res) => {
    const ws = await requireWorkspace(db, callerOf(res), req.params.workspaceId);
    res.json(await previewExport(db, ws.id, req.body, clock.now()));
  });

  // ---- Exports ----
  api.post('/workspaces/:workspaceId/exports', async (req, res) => {
    const caller = callerOf(res);
    const ws = await requireWorkspace(db, caller, req.params.workspaceId);
    const request = ManualExportSchema.parse(req.body);
    const { job, created } = await createManualExport(db, caller, ws, request, { clock, ...settings });
    res.status(created ? 202 : 200).json(jobSummaryDto(job));
  });

  api.get('/workspaces/:workspaceId/exports', async (req, res) => {
    const ws = await requireWorkspace(db, callerOf(res), req.params.workspaceId);
    const jobs = await listJobs(db, ws.id, ListQuery.parse(req.query));
    res.json({ items: jobs.map(jobSummaryDto) });
  });

  api.get('/exports/:jobId', async (req, res) => {
    const job = await getJobForTenant(db, callerOf(res).tenantId, req.params.jobId);
    const [tasks, artifact] = await Promise.all([listTasks(db, job.id), getArtifact(db, job.id)]);
    res.json(jobDetailDto(job, tasks, artifact));
  });

  api.post('/exports/:jobId/retry', async (req, res) => {
    const job = await getJobForTenant(db, callerOf(res).tenantId, req.params.jobId);
    res.status(202).json(jobSummaryDto(await retryJob(db, job.id, settings.maxAttempts)));
  });

  api.get('/exports/:jobId/file', async (req, res) => {
    const job = await getJobForTenant(db, callerOf(res).tenantId, req.params.jobId);
    const artifact = await getArtifact(db, job.id);
    if (!artifact) throw notFound('The file is not ready yet');
    res.download(storage.resolve(artifact.location), artifact.file_name);
  });

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
