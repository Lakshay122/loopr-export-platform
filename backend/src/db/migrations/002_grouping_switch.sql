-- A schedule change (for example hourly -> per session) starts at a clean boundary, not right away.
-- effective_from is set only on the version that changes the grouping. NULL means
-- "same grouping as the version before" (or the very first version).
ALTER TABLE export_config_version ADD COLUMN effective_from TIMESTAMPTZ;
