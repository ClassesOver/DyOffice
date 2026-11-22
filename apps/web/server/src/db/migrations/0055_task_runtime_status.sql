-- A single status projection for the three executors. Callers still authorize the
-- session or channel before querying it. No instructions, checkpoints or credentials.
CREATE VIEW task_runtime_status WITH (security_invoker = true) AS
 SELECT 'codex'::text AS executor, r.deployment_id, r.owner_id, r.file_id,
        r.session_id, NULL::uuid AS conversation_id, r.turn_id AS task_id,
        r.state AS stored_state,
        CASE WHEN r.state IN ('running','cancel_requested') AND r.lease_until<=clock_timestamp()
             THEN 'unknown_outcome' ELSE r.state END AS state,
        r.state='cancel_requested' AS cancel_requested,
        r.lease_until, r.expires_at
 FROM harness_task_recovery r
 UNION ALL
 SELECT CASE WHEN t.execution='saved-revision' THEN 'background' ELSE 'channel' END,
        t.deployment_id, t.owner_id, ch.file_id, NULL::uuid, t.conversation_id,
        t.task_id::text, t.state, t.state, t.cancel_requested, q.lease_until, NULL::timestamptz
 FROM assistant_tasks t
 JOIN assistant_channels ch USING(deployment_id,owner_id,conversation_id)
 LEFT JOIN assistant_background_queue q USING(deployment_id,owner_id,conversation_id,task_id);
REVOKE ALL ON task_runtime_status FROM PUBLIC;
