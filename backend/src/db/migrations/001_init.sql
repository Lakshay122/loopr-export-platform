-- =====================================================================
-- Part 1: simulated source data (owned by the existing inspection platform)
-- The export platform only READS these tables.
-- =====================================================================

CREATE TABLE tenant (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL
);

CREATE TABLE workspace (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenant(id),
  name        TEXT NOT NULL
);
CREATE INDEX workspace_tenant_idx ON workspace (tenant_id);

CREATE TABLE inspection_session (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX inspection_session_workspace_idx ON inspection_session (workspace_id);

-- A record is "finalized" once finalized_at is set. Finalized records never change.
CREATE TABLE inspection_record (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  session_id       TEXT NOT NULL REFERENCES inspection_session(id),
  part_serial      TEXT NOT NULL,
  inspection_type  TEXT NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL', 'REVIEW')),
  defect           TEXT,
  image_ref        TEXT,
  inspected_at     TIMESTAMPTZ NOT NULL,
  finalized_at     TIMESTAMPTZ
);
-- Export reads walk records in (inspected_at, id) order inside a workspace.
CREATE INDEX inspection_record_ws_time_idx ON inspection_record (workspace_id, inspected_at, id);
CREATE INDEX inspection_record_ws_final_idx ON inspection_record (workspace_id, finalized_at);
CREATE INDEX inspection_record_session_idx ON inspection_record (session_id, inspected_at, id);

-- =====================================================================
-- Part 2: export platform tables
-- =====================================================================

-- One export configuration per workspace (prototype rule D-01).
CREATE TABLE export_config (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     TEXT NOT NULL UNIQUE REFERENCES workspace(id),
  current_version  INT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every edit creates a new immutable version (D-09). Rows are never updated.
CREATE TABLE export_config_version (
  config_id   UUID NOT NULL REFERENCES export_config(id),
  version     INT NOT NULL,
  spec        JSONB NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (config_id, version)
);

-- A group of records that is exported together: one hour, or one session (D-13).
-- last_cutoff is the "seen up to" bookmark. It only moves after a file is published.
CREATE TABLE export_partition (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             TEXT NOT NULL REFERENCES workspace(id),
  config_id                UUID NOT NULL REFERENCES export_config(id),
  partition_type           TEXT NOT NULL CHECK (partition_type IN ('TIME', 'SESSION')),
  partition_key            TEXT NOT NULL,
  range_start              TIMESTAMPTZ,
  range_end                TIMESTAMPTZ,
  session_id               TEXT,
  ready_at                 TIMESTAMPTZ NOT NULL,
  closed_by_event_id       TEXT,
  original_config_version  INT,
  last_cutoff              TIMESTAMPTZ,
  last_correction_no       INT NOT NULL DEFAULT -1,
  in_flight_job_id         UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (config_id, partition_key)
);
CREATE INDEX export_partition_ready_idx ON export_partition (ready_at) WHERE last_cutoff IS NULL;

CREATE TABLE export_job (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT NOT NULL REFERENCES tenant(id),
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  config_id        UUID NOT NULL REFERENCES export_config(id),
  config_version   INT NOT NULL,
  trigger          TEXT NOT NULL CHECK (trigger IN ('SCHEDULED', 'CORRECTION', 'MANUAL')),
  status           TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  partition_id     UUID REFERENCES export_partition(id),
  correction_no    INT,
  -- What to read. Fixed when the job is created, so retries read the same rows.
  range_start      TIMESTAMPTZ,
  range_end        TIMESTAMPTZ,
  session_id       TEXT,
  prev_cutoff      TIMESTAMPTZ,
  cutoff           TIMESTAMPTZ NOT NULL,
  extra_filters    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Manual exports
  request_id       TEXT,
  requested_by     TEXT,
  -- Outcome
  file_name        TEXT NOT NULL,
  row_count        INT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  FOREIGN KEY (config_id, config_version) REFERENCES export_config_version(config_id, version),
  UNIQUE (partition_id, correction_no),
  UNIQUE (workspace_id, request_id)
);
CREATE INDEX export_job_ws_created_idx ON export_job (workspace_id, created_at DESC);

ALTER TABLE export_partition
  ADD CONSTRAINT export_partition_in_flight_fk FOREIGN KEY (in_flight_job_id) REFERENCES export_job(id);

-- A job is split into CHUNK tasks plus one FINALIZE task.
-- WAITING is used only by FINALIZE until every chunk has succeeded.
CREATE TABLE export_task (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES export_job(id),
  kind          TEXT NOT NULL CHECK (kind IN ('CHUNK', 'FINALIZE')),
  seq           INT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('WAITING', 'READY', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED')),
  -- Chunk range: rows with (inspected_at, id) > lower and <= upper. NULL means open-ended.
  lower_at      TIMESTAMPTZ,
  lower_id      TEXT,
  upper_at      TIMESTAMPTZ,
  upper_id      TEXT,
  attempt       INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL,
  lease_until   TIMESTAMPTZ,
  run_after     TIMESTAMPTZ,
  worker_id     TEXT,
  row_count     INT,
  last_error    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, kind, seq)
);
CREATE INDEX export_task_job_idx ON export_task (job_id);
CREATE INDEX export_task_running_idx ON export_task (lease_until) WHERE status = 'RUNNING';
CREATE INDEX export_task_ready_idx ON export_task (updated_at) WHERE status = 'READY';

-- Transactional outbox: "this task should be sent to the queue".
-- Written in the same transaction as the task change, published later by the dispatcher.
CREATE TABLE export_outbox (
  id            BIGSERIAL PRIMARY KEY,
  task_id       UUID NOT NULL REFERENCES export_task(id),
  available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX export_outbox_pending_idx ON export_outbox (available_at) WHERE published_at IS NULL;

-- The final published file of a job.
CREATE TABLE export_artifact (
  job_id      UUID PRIMARY KEY REFERENCES export_job(id),
  file_name   TEXT NOT NULL,
  location    TEXT NOT NULL,
  row_count   INT NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Late records that arrived after the correction lookback ended. They need a manual backfill.
CREATE TABLE late_record_flag (
  record_id     TEXT NOT NULL REFERENCES inspection_record(id),
  partition_id  UUID NOT NULL REFERENCES export_partition(id),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, partition_id)
);

-- Source events we already handled (for example session.completed), so duplicates are ignored.
CREATE TABLE processed_event (
  event_id      TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
