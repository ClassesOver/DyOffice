ALTER TABLE task_runtime_channel ADD COLUMN continuation_origin jsonb,
  ADD CONSTRAINT channel_continuation_origin CHECK (continuation_origin IS NULL OR
    (sender='office' AND recipient='office' AND parent_task_id IS NULL AND jsonb_typeof(continuation_origin)='object'));
