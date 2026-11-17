CREATE TABLE assistant_channels (
 conversation_id uuid PRIMARY KEY, deployment_id uuid NOT NULL, owner_id uuid NOT NULL,
 file_id uuid NOT NULL, paused boolean NOT NULL DEFAULT false,
 sequence bigint NOT NULL DEFAULT 0, office_connection_id uuid, office_epoch integer NOT NULL DEFAULT 0,
 editor_id uuid, editor_generation integer, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(deployment_id,owner_id,conversation_id),
 FOREIGN KEY(deployment_id,owner_id) REFERENCES users(deployment_id,id) ON DELETE RESTRICT
);
CREATE TABLE assistant_invites (
 id uuid PRIMARY KEY, deployment_id uuid NOT NULL, owner_id uuid NOT NULL, conversation_id uuid NOT NULL,
 token_hash text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 FOREIGN KEY(deployment_id,owner_id,conversation_id) REFERENCES assistant_channels(deployment_id,owner_id,conversation_id) ON DELETE RESTRICT
);
CREATE TABLE assistant_applications (
 id uuid PRIMARY KEY, deployment_id uuid NOT NULL, owner_id uuid NOT NULL, conversation_id uuid NOT NULL,
 token_hash text NOT NULL, display_name text NOT NULL, kind text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','redeemed')),
 expires_at timestamptz NOT NULL, membership_id uuid,
 FOREIGN KEY(deployment_id,owner_id,conversation_id) REFERENCES assistant_channels(deployment_id,owner_id,conversation_id) ON DELETE RESTRICT
);
CREATE TABLE assistant_members (
 membership_id uuid PRIMARY KEY, deployment_id uuid NOT NULL, owner_id uuid NOT NULL, conversation_id uuid NOT NULL,
 agent_id uuid NOT NULL, harness_session_id uuid NOT NULL, display_name text NOT NULL, kind text NOT NULL,
 token_hash text, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 connection_id uuid, connection_epoch integer NOT NULL DEFAULT 0, last_seen_at timestamptz,
 FOREIGN KEY(deployment_id,owner_id,conversation_id) REFERENCES assistant_channels(deployment_id,owner_id,conversation_id) ON DELETE RESTRICT
);
CREATE TABLE assistant_tasks (
 task_id uuid PRIMARY KEY, deployment_id uuid NOT NULL, owner_id uuid NOT NULL, conversation_id uuid NOT NULL,
 root_task_id uuid NOT NULL, parent_task_id uuid, depth integer NOT NULL CHECK(depth BETWEEN 0 AND 4),
 sender text NOT NULL, recipient text NOT NULL, instruction text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','waiting_peer','cancel_requested','succeeded','failed','cancelled','unknown_outcome')),
 claim_id uuid, connection_id uuid, connection_epoch integer, child_task_ids jsonb NOT NULL DEFAULT '[]',
 cancel_requested boolean NOT NULL DEFAULT false, summary text, outcome text, deadline_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(deployment_id,owner_id,conversation_id) REFERENCES assistant_channels(deployment_id,owner_id,conversation_id) ON DELETE RESTRICT
);
CREATE INDEX assistant_tasks_channel ON assistant_tasks(deployment_id,owner_id,conversation_id,created_at);
CREATE TABLE assistant_events (
 event_id uuid PRIMARY KEY, deployment_id uuid NOT NULL, owner_id uuid NOT NULL, conversation_id uuid NOT NULL,
 sequence bigint NOT NULL, task_id uuid, audience text NOT NULL, type text NOT NULL, payload jsonb NOT NULL,
 UNIQUE(conversation_id,sequence),
 FOREIGN KEY(deployment_id,owner_id,conversation_id) REFERENCES assistant_channels(deployment_id,owner_id,conversation_id) ON DELETE RESTRICT
);
CREATE TABLE assistant_requests (
 deployment_id uuid NOT NULL, owner_id uuid NOT NULL, conversation_id uuid NOT NULL, actor text NOT NULL,
 request_id uuid NOT NULL, params_hash text NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(conversation_id,actor,request_id),
 FOREIGN KEY(deployment_id,owner_id,conversation_id) REFERENCES assistant_channels(deployment_id,owner_id,conversation_id) ON DELETE RESTRICT
);
DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['assistant_channels','assistant_invites','assistant_applications','assistant_members','assistant_tasks','assistant_events','assistant_requests'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY own_assistant ON %I USING (deployment_id=NULLIF(current_setting(''dyoffice.deployment_id'',true),'''')::uuid AND owner_id=NULLIF(current_setting(''dyoffice.user_id'',true),'''')::uuid) WITH CHECK (deployment_id=NULLIF(current_setting(''dyoffice.deployment_id'',true),'''')::uuid AND owner_id=NULLIF(current_setting(''dyoffice.user_id'',true),'''')::uuid)',relation);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
 END LOOP;
END $$;
