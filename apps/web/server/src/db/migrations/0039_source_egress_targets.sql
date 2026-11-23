ALTER TABLE global_configs
  ADD COLUMN source_egress_targets jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(source_egress_targets) = 'array' AND jsonb_array_length(source_egress_targets) <= 256);
