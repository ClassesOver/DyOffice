ALTER TABLE files ADD COLUMN auto_name_pending boolean NOT NULL DEFAULT false;
ALTER TABLE uploads ADD COLUMN auto_name_pending boolean NOT NULL DEFAULT false;
