# events

Handles source events from the inspection platform. Today: `session.completed`.

In production these would come from a stream (Kafka / Azure Event Hubs). In the prototype they arrive through
`POST /internal/events` or the CLI command `complete-session`.

## What `handleSessionCompleted` does

1. Saves the event id in `processed_event`. Seen before → `duplicate-event`, nothing else happens.
2. Checks the session belongs to the workspace.
3. If the workspace groups by `session_id` at that moment, creates a SESSION partition with
   `ready_at = max(event time, now) + settleSeconds`. Partition already exists → `already-closed`.
   Around a schedule change the session only covers its part of the per-session period (`range_start` /
   `range_end`), so records are never in both an hourly file and a session file.
4. Otherwise → `ignored`.

"Session completed" means "probably ready", not "every record is final". The settle delay gives late writes time
to land, and anything finalized even later goes into a correction file for that session.
