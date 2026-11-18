# worker

`TaskRunner.run(taskId)` runs one task from start to end. BullMQ calls it for every message.

## Steps

1. **Claim** the task in PostgreSQL. If it is not claimable (already done, already running, job failed) → do nothing.
   This makes duplicate messages harmless.
2. Load the job and its **pinned** config version.
3. Do the work:
   - **CHUNK** – read the chunk's fixed key range page by page (500 rows), format each row, write a staged chunk file.
   - **FINALIZE** – write header + all chunk files into a temp file, then rename it to the final name (atomic).
4. **Commit** in one transaction, only if this worker still owns the attempt:
   - CHUNK: mark SUCCEEDED; if it was the last chunk, release FINALIZE.
   - FINALIZE: mark SUCCEEDED, save the artifact (location, rows, SHA-256), mark the job COMPLETED,
     and move the group's bookmark (`last_cutoff`) forward.
5. On error: `PermanentError` → FAILED now. Anything else → RETRY_WAIT with backoff, until attempts run out.

The file is always written **before** the commit. If we crash in between, the retry writes the same file again
(same name, same content). If we committed first and then crashed while writing, the database would say
"done" for a file that does not exist — that order is never used.

## Test seam

`FaultHooks.afterWrite` lets tests fail or pause a task right after the file is written and before the commit.
It is not used in production.
