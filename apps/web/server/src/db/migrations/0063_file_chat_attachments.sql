ALTER TABLE file_assistant_messages ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
