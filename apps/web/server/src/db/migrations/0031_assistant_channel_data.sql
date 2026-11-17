ALTER TABLE assistant_tasks ADD COLUMN data_inputs jsonb CHECK (data_inputs IS NULL OR jsonb_typeof(data_inputs)='object');
