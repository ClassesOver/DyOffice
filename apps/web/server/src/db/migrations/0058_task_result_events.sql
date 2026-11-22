ALTER TABLE harness_task_events DROP CONSTRAINT harness_task_events_kind_check,
  ADD CONSTRAINT harness_task_events_kind_check CHECK(kind IN ('state','activity','progress','result'));
