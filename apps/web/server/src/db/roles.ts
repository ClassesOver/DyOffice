import { getMigrationManifest } from './migration-manifest.ts'
import { randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

type Queryable = Pick<Pool, 'query'>
const identifier = (value: string) => { if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) throw new Error('Invalid database role name'); return '"' + value + '"' }
const quoted = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const table = (schema: string, name: string) => quoted(schema) + '.' + quoted(name)
const authTables = ['users','user_roles','sessions','password_action_tokens','login_challenges','login_throttles','auth_security_events','auth_audit_events','deployments','identity_migrations']
const privateTables = ['mcp_read_grants','dsh_edit_grants']
const runtimeViews = ['task_runtime_status','assistant_tasks','harness_task_recovery','assistant_background_queue']
const personalTables = ['task_runtime','task_runtime_codex','harness_task_events','file_assistant_messages','word_collab_steps','workspaces','personal_preferences','user_skills','user_style_templates','files','file_revisions','uploads','storage_accounts','edit_leases','revision_commits','revision_outbox','native_jobs','job_outbox','workspace_folders','workspace_file_state','command_journal','command_upload_bindings','data_sources','data_source_drafts','data_source_versions','data_source_credentials','data_source_audit','realtime_tickets','realtime_command_deliveries','workspace_source_results','harness_artifact_accounts','harness_artifact_tasks','harness_artifacts','harness_analysis_deliveries','assistant_channels','assistant_invites','assistant_applications','assistant_members','task_runtime_channel','assistant_events','assistant_requests','task_background_claims']
const globalTables = ['office_embed_settings','global_configs','global_config_entries','global_config_secrets','global_config_audit']
const jobFunctions = ['take_assistant_background(uuid,text)','abandon_assistant_background(uuid,uuid,uuid,text)','take_revision_delivery(uuid,text,integer)','ack_revision_delivery(uuid,uuid,bigint,text,integer)','take_job_delivery(uuid,text,integer)','ack_job_delivery(uuid,uuid,bigint,text,integer)','claim_native_job(uuid,uuid,text,integer)','renew_native_job(uuid,uuid,bigint,text,integer)','fail_native_job(uuid,uuid,bigint,text,text,boolean)']
const businessJobFunctions = ['lock_job_principal(uuid,uuid,bigint,text,boolean)','complete_native_job(uuid,uuid,bigint,text,uuid)']
const businessDshFunctions = ['issue_dsh_edit_grant(uuid,uuid,uuid,boolean,text)','lock_dsh_edit_grant(uuid,text,bigint,text)']
const businessMcpFunctions = [
  'issue_mcp_read_grant(uuid,text,bigint,uuid,text,uuid,uuid)',
  'revoke_mcp_read_grant(uuid,text,bigint,uuid)',
  'lock_mcp_file_grant(uuid,text,bigint,text)',
  'record_mcp_edit(uuid,text,bigint,uuid)',
  'issue_mcp_edit_grant(uuid,text,bigint,uuid,text,uuid,uuid,jsonb)',
]
const authFunctions = ['read_office_embed_origins(uuid)', 'read_login_history(uuid,text,bigint)', 'read_login_history_page(uuid,text,bigint,integer,uuid)']
const globalFunctions = ['shared_provider_catalog()','shared_provider_dispatch(text,text,text,integer,text)','shared_provider_secret(text,text,integer,text)','personal_provider_budget_action(text,text,text,integer,text,uuid)','personal_provider_secret(text,text,integer,text,uuid,uuid)','personal_provider_catalog()','global_config_authorized(uuid,boolean)','global_ai_tool_provider(text)','global_config_key_readiness()']
const schemaFunctions = ['native_schema_matches(jsonb)']
const deploymentFunctions = ['native_deployment_ready(uuid)']
const privateJobFunctions = ['lock_native_job(uuid,uuid)','native_job_authorized(native_jobs)','close_native_job(uuid,uuid,text,text)']
const functionName = (schema: string, signature: string) => { const [name,args] = signature.split('('); return table(schema,name) + '(' + args.replace('native_jobs',table(schema,'native_jobs')) }
async function grantRuntimePrivileges(connection: Queryable, { authRole, businessRole, workerRole }: { authRole: string; businessRole: string; workerRole?: string }) {
  const auth = identifier(authRole), business = identifier(businessRole)
  const roleNames = [authRole,businessRole,...(workerRole ? [workerRole] : [])], runtime = roleNames.map(identifier).join(',')
  if (new Set(roleNames).size !== roleNames.length) throw new Error('Authentication and business roles must differ')
  const { rows: [owner] } = await connection.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  if (owner.rolsuper || owner.rolbypassrls || roleNames.includes(owner.name)) throw new Error('A separate non-superuser migration owner is required')
  const { rows: [location] } = await connection.query('SELECT current_schema() AS schema,current_database() AS database')
  const schema = location.schema as string
  for (const name of roleNames) {
    const { rows: [role] } = await connection.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit FROM pg_roles WHERE rolname=$1', [name])
    if (!role || Object.values(role).some(Boolean)) throw new Error('Runtime roles must already exist with restricted flags and NOINHERIT')
  }
  await connection.query(`REVOKE CREATE,TEMPORARY ON DATABASE ${quoted(location.database)} FROM PUBLIC`)
  await connection.query(`GRANT CONNECT ON DATABASE ${quoted(location.database)} TO ${runtime}`)
  await connection.query(`REVOKE CREATE ON SCHEMA ${quoted(schema)} FROM PUBLIC`)
  await connection.query(`GRANT USAGE ON SCHEMA ${quoted(schema)} TO ${runtime}`)
  for (const name of [...authTables,...personalTables,...globalTables,...privateTables,...runtimeViews]) await connection.query(`REVOKE ALL ON ${table(schema,name)} FROM ${runtime}`)
  for (const name of ['users','sessions','password_action_tokens']) await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${table(schema,name)} TO ${auth}`)
  await connection.query(`GRANT SELECT,INSERT,DELETE ON ${table(schema,'user_roles')} TO ${auth}`)
  for (const name of ['login_challenges','login_throttles']) await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(schema,name)} TO ${auth}`)
  for (const name of ['deployments','identity_migrations']) await connection.query(`GRANT SELECT ON ${table(schema,name)} TO ${auth}`)
  await connection.query(`GRANT INSERT ON ${table(schema,'auth_security_events')},${table(schema,'workspaces')} TO ${auth}`)
  await connection.query(`GRANT SELECT ON ${[...runtimeViews,'task_runtime','workspaces'].map(name=>table(schema,name)).join(',')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(schema,'personal_preferences')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(schema,'user_skills')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(schema,'user_style_templates')} TO ${business}`)
  for (const name of ['file_assistant_messages','task_runtime_codex']) await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(schema,name)} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,DELETE ON ${table(schema,'word_collab_steps')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,DELETE ON ${table(schema,'harness_task_events')} TO ${business}`)
  for (const name of ['files','uploads','storage_accounts','edit_leases']) await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${table(schema,name)} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT ON ${table(schema,'file_revisions')} TO ${business}`)
  await connection.query(`GRANT UPDATE(reclaimed_at) ON ${table(schema,'file_revisions')} TO ${business}`)
  await connection.query(`GRANT UPDATE(retired_at,delivery_epoch,delivery_hash,delivery_until) ON ${table(schema,'revision_outbox')} TO ${business}`)
  for (const name of ['revision_commits','revision_outbox']) await connection.query(`GRANT SELECT,INSERT ON ${table(schema,name)} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${table(schema,'native_jobs')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT ON ${table(schema,'job_outbox')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${table(schema,'global_configs')},${table(schema,'office_embed_settings')} TO ${business}`)
  for (const name of ['global_config_entries','global_config_secrets']) await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(schema,name)} TO ${business}`)
  await connection.query(`GRANT INSERT ON ${table(schema,'global_config_audit')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(schema,'workspace_folders')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${table(schema,'workspace_file_state')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${table(schema,'command_journal')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT ON ${table(schema,'command_upload_bindings')} TO ${business}`)

  // Vault/history rows are append-only for the business role: SELECT ciphertext
  // for authorized execution, never UPDATE/DELETE (rotation appends).
  // Roots are permanent tombstones after logical deletion; runtime cannot remove the reserved key.
  await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${table(schema,'data_sources')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${table(schema,'data_source_drafts')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT ON ${table(schema,'data_source_versions')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT ON ${table(schema,'data_source_credentials')} TO ${business}`)
  await connection.query(`GRANT INSERT ON ${table(schema,'data_source_audit')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table(schema,'realtime_tickets')} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT ON ${table(schema,'realtime_command_deliveries')} TO ${business}`)
  // Materialized data is independent of files/object accounting. Only pending
  // rows are reclaimed by the service; saved evidence/receipts are permanent.
  await connection.query(`GRANT SELECT,INSERT,DELETE ON ${table(schema,'workspace_source_results')} TO ${business}`)
  await connection.query(`GRANT UPDATE(state,session_id,name,save_command_id,save_params_hash,expires_at,saved_at) ON ${table(schema,'workspace_source_results')} TO ${business}`)
  for (const name of ['harness_artifact_accounts','harness_artifact_tasks','harness_analysis_deliveries']) await connection.query(`GRANT SELECT,INSERT ON ${table(schema,name)} TO ${business}`)
  await connection.query(`GRANT SELECT,INSERT,DELETE ON ${table(schema,'harness_artifacts')} TO ${business}`)
  await connection.query(`GRANT UPDATE(used_bytes) ON ${table(schema,'harness_artifact_accounts')} TO ${business}`)
  for (const name of ['harness_artifact_tasks','harness_artifacts']) await connection.query(`GRANT UPDATE(state) ON ${table(schema,name)} TO ${business}`)
  for (const name of ['assistant_channels','assistant_invites','assistant_applications','assistant_members','task_runtime_channel','assistant_events','assistant_requests','task_background_claims']) await connection.query(`GRANT SELECT,INSERT,DELETE ON ${table(schema,name)} TO ${business}`)
  for (const [name,columns] of Object.entries({task_runtime:['state','cancel_requested'],assistant_channels:['file_id','background_enabled','paused','sequence','office_connection_id','office_epoch','editor_id','editor_generation'],assistant_invites:['consumed_at'],assistant_applications:['state','membership_id'],assistant_members:['dsh_token_issued_at','dsh_token_session_id','dsh_token_envelope','token_hash','revoked_at','connection_id','connection_epoch','last_seen_at'],task_background_claims:['credential','claim_id','claim_hash'],task_runtime_channel:['lease_until','renewed_at','execution','saved_revision','saved_sha256','saved_size','state','claim_id','connection_id','connection_epoch','child_task_ids','summary','outcome','cancel_requested']})) await connection.query(`GRANT UPDATE(${columns.join(',')}) ON ${table(schema,name)} TO ${business}`)
  await connection.query(`REVOKE ALL ON FUNCTION ${table(schema,'lock_business_session')}(uuid,text,bigint) FROM ${runtime}`)
  for (const signature of [...jobFunctions,...businessJobFunctions,...businessMcpFunctions,...businessDshFunctions,...schemaFunctions,...deploymentFunctions,...privateJobFunctions,...authFunctions,...globalFunctions]) await connection.query(`REVOKE ALL ON FUNCTION ${functionName(schema,signature)} FROM ${runtime}`)
  for (const signature of authFunctions) await connection.query(`GRANT EXECUTE ON FUNCTION ${functionName(schema,signature)} TO ${auth}`)
  for (const signature of [...businessJobFunctions,...businessMcpFunctions,...businessDshFunctions]) await connection.query(`GRANT EXECUTE ON FUNCTION ${functionName(schema,signature)} TO ${business}`)
  for (const signature of globalFunctions) await connection.query(`GRANT EXECUTE ON FUNCTION ${functionName(schema,signature)} TO ${business}`)
  for (const signature of schemaFunctions) await connection.query(`GRANT EXECUTE ON FUNCTION ${functionName(schema,signature)} TO ${business}${workerRole ? ',' + identifier(workerRole) : ''}`)
  if (workerRole) for (const signature of [...jobFunctions,...deploymentFunctions]) await connection.query(`GRANT EXECUTE ON FUNCTION ${functionName(schema,signature)} TO ${identifier(workerRole)}`)
  await connection.query(`GRANT EXECUTE ON FUNCTION ${table(schema,'lock_business_session')}(uuid,text,bigint) TO ${business}`)
}

export async function provisionRuntimeRoles(pool: Pool, options: { authRole: string; businessRole: string; workerRole?: string }) {
  const connection = await pool.connect()
  let discard: Error | undefined
  try {
    await connection.query('BEGIN')
    await grantRuntimePrivileges(connection, options)
    await connection.query('COMMIT')
  } catch (error) {
    try { await connection.query('ROLLBACK') } catch (rollback) { discard = rollback instanceof Error ? rollback : new Error('Rollback failed') }
    throw error
  } finally { connection.release(discard) }
}

export async function assertRuntimePool(pool: Pool, kind: 'auth' | 'business' | 'worker') {
  const { rows: [role] } = await pool.query('SELECT current_user AS name,session_user AS login,current_schema() AS schema,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user')
  if (role.name !== role.login || ['rolsuper','rolbypassrls','rolcreatedb','rolcreaterole','rolreplication','rolinherit'].some(key => role[key])) throw new Error('Runtime connection must use a restricted login role')
  const inherited = await pool.query('SELECT 1 FROM pg_roles WHERE rolname<>current_user AND pg_has_role(current_user,oid,\'MEMBER\')')
  if (inherited.rowCount) throw new Error('Runtime role must have no role memberships')
  const privileges = (await pool.query("SELECT has_schema_privilege(current_user,$1,'CREATE') AS create_schema,has_database_privilege(current_user,current_database(),'CREATE,TEMPORARY') AS create_database_objects", [role.schema])).rows[0]
  if (privileges.create_schema || privileges.create_database_objects) throw new Error('Runtime role must not create schema objects')
  const required: Record<string, string[]> = kind === 'business'
    ? { office_embed_settings: ['SELECT','INSERT','UPDATE'], user_skills: ['SELECT','INSERT','UPDATE','DELETE'], command_journal: ['SELECT','INSERT','UPDATE'], command_upload_bindings: ['SELECT','INSERT'], realtime_tickets: ['SELECT','INSERT','UPDATE','DELETE'], realtime_command_deliveries: ['SELECT','INSERT'], workspace_folders: ['SELECT','INSERT','UPDATE','DELETE'], workspace_file_state: ['SELECT','INSERT','UPDATE'], global_configs: ['SELECT','INSERT','UPDATE'], global_config_entries: ['SELECT','INSERT','UPDATE','DELETE'], global_config_secrets: ['SELECT','INSERT','UPDATE','DELETE'], global_config_audit: ['INSERT'], native_jobs: ['SELECT','INSERT','UPDATE'], job_outbox: ['SELECT','INSERT'], edit_leases: ['SELECT','INSERT','UPDATE'], revision_commits: ['SELECT','INSERT'], revision_outbox: ['SELECT','INSERT'], files: ['SELECT','INSERT','UPDATE'], uploads: ['SELECT','INSERT','UPDATE'], storage_accounts: ['SELECT','INSERT','UPDATE'], file_revisions: ['SELECT','INSERT'], workspaces: ['SELECT'], personal_preferences: ['SELECT','INSERT','UPDATE','DELETE'], data_sources: ['SELECT','INSERT','UPDATE'], data_source_drafts: ['SELECT','INSERT','UPDATE'], data_source_versions: ['SELECT','INSERT'], data_source_credentials: ['SELECT','INSERT'], data_source_audit: ['INSERT'], workspace_source_results: ['SELECT','INSERT','DELETE'] }
    : kind === 'worker' ? {} : { users: ['SELECT','INSERT','UPDATE'], user_roles: ['SELECT','INSERT','DELETE'], sessions: ['SELECT','INSERT','UPDATE'], password_action_tokens: ['SELECT','INSERT','UPDATE'], login_challenges: ['SELECT','INSERT','UPDATE','DELETE'], login_throttles: ['SELECT','INSERT','UPDATE','DELETE'], auth_security_events: ['INSERT'], identity_migrations: ['SELECT'], deployments: ['SELECT'], workspaces: ['INSERT'] }
  if(kind==='business')for(const name of ['assistant_channels','assistant_invites','assistant_applications','assistant_members','task_runtime_channel','assistant_events','assistant_requests','task_background_claims'])required[name]=['SELECT','INSERT','DELETE']
  if (kind === 'business') for (const name of ['file_assistant_messages','task_runtime_codex']) required[name] = ['SELECT','INSERT','UPDATE','DELETE']
  if (kind === 'business') for (const name of [...runtimeViews,'task_runtime']) required[name] = ['SELECT']
  if (kind === 'business') required.word_collab_steps = ['SELECT','INSERT','DELETE']
  if (kind === 'business') required.harness_task_events = ['SELECT','INSERT','DELETE']
  if (kind === 'business') required.user_style_templates = ['SELECT','INSERT','UPDATE','DELETE']
  if (kind === 'business') Object.assign(required, { harness_artifact_accounts: ['SELECT','INSERT'], harness_artifact_tasks: ['SELECT','INSERT'], harness_artifacts: ['SELECT','INSERT','DELETE'], harness_analysis_deliveries: ['SELECT','INSERT'] })
  const permissions = ['SELECT','INSERT','UPDATE','DELETE','REFERENCES','TRIGGER']
  const { rows: [version] } = await pool.query("SELECT current_setting('server_version_num')::integer AS number")
  if (version.number >= 170000) permissions.push('MAINTAIN')
  for (const name of [...authTables,...personalTables,...globalTables,...privateTables,...runtimeViews]) {
    const relation = table(role.schema, name)
    const flags = (await pool.query("SELECT c.relowner=r.oid AS owned,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncate,EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=r.oid AND a.is_grantable) AS table_delegatable,EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee=r.oid AND a.is_grantable) AS column_delegatable FROM pg_class c JOIN pg_roles r ON r.rolname=current_user WHERE c.oid=$1::regclass", [relation])).rows[0]
    if (!flags || flags.owned || flags.truncate || (flags.table_delegatable || flags.column_delegatable)) throw new Error('Runtime role must not own or truncate application tables')
    if (runtimeViews.includes(name) && !(await pool.query(
      "SELECT 1 FROM pg_class WHERE oid=$1::regclass AND relkind='v' AND 'security_invoker=true'=ANY(reloptions)", [relation],
    )).rowCount) throw new Error('Task status must enforce caller row security')
    if (personalTables.includes(name) && (!flags.relrowsecurity || !flags.relforcerowsecurity)) throw new Error('Personal tables require FORCE RLS')
    if (globalTables.includes(name) && (!flags.relrowsecurity || !flags.relforcerowsecurity)) throw new Error('Global tables require FORCE RLS')
    for (const permission of permissions) {
      if (required[name]?.includes(permission)) continue
      const channelColumns:Record<string,string[]>={task_runtime:['state','cancel_requested'],assistant_channels:['file_id','background_enabled','paused','sequence','office_connection_id','office_epoch','editor_id','editor_generation'],assistant_invites:['consumed_at'],assistant_applications:['state','membership_id'],assistant_members:['dsh_token_issued_at','dsh_token_session_id','dsh_token_envelope','token_hash','revoked_at','connection_id','connection_epoch','last_seen_at'],task_background_claims:['credential','claim_id','claim_hash'],task_runtime_channel:['lease_until','renewed_at','execution','saved_revision','saved_sha256','saved_size','state','claim_id','connection_id','connection_epoch','child_task_ids','summary','outcome','cancel_requested']}
      const lifecycleColumns = channelColumns[name] ?? (name === 'harness_artifact_accounts' ? ['used_bytes'] : ['harness_artifact_tasks','harness_artifacts'].includes(name) ? ['state'] : name === 'file_revisions' ? ['reclaimed_at'] : name === 'revision_outbox' ? ['retired_at','delivery_epoch','delivery_hash','delivery_until'] : name === 'workspace_source_results' ? ['state','session_id','name','save_command_id','save_params_hash','expires_at','saved_at'] : null)
      if (kind === 'business' && permission === 'UPDATE' && lifecycleColumns) {
        const actual = await pool.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege(current_user,attrelid,attnum,'UPDATE') ORDER BY attname",[relation])
        if (JSON.stringify(actual.rows.map(row => row.attname)) !== JSON.stringify([...lifecycleColumns].sort())) throw new Error('Runtime lifecycle columns violate privilege boundary')
        continue
      }
      const column = ['SELECT','INSERT','UPDATE','REFERENCES'].includes(permission)
      const result = (await pool.query(`SELECT has_table_privilege(current_user,$1,$2) ${column ? 'OR has_any_column_privilege(current_user,$1,$2)' : ''} AS allowed`, [relation, permission])).rows[0]
      if (result.allowed) throw new Error('Runtime role has privileges outside its boundary')
    }
  }
  for (const [name, permissions] of Object.entries(required)) {
    for (const permission of permissions) {
      const { rows: [result] } = await pool.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [table(role.schema,name), permission])
      if (!result.allowed) throw new Error('Runtime role lacks required privileges')
    }
  }
  if (kind === 'auth' && (await pool.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS allowed", [table(role.schema,'workspaces')])).rows[0].allowed) throw new Error('Auth role must not read personal workspaces')
  for (const [proc,executable] of [[table(role.schema,'lock_business_session') + '(uuid,text,bigint)',kind === 'business'],...jobFunctions.map(signature => [functionName(role.schema,signature),kind === 'worker']),...[...businessJobFunctions,...businessMcpFunctions,...businessDshFunctions].map(signature => [functionName(role.schema,signature),kind === 'business']),...globalFunctions.map(signature => [functionName(role.schema,signature),kind === 'business']),...schemaFunctions.map(signature => [functionName(role.schema,signature),kind !== 'auth']),...deploymentFunctions.map(signature => [functionName(role.schema,signature),kind === 'worker']),...privateJobFunctions.map(signature => [functionName(role.schema,signature),false]),...authFunctions.map(signature => [functionName(role.schema,signature),kind === 'auth'])] as [string,boolean][]) {
    const fn = (await pool.query("SELECT p.proowner=(SELECT relowner FROM pg_class WHERE oid=$2::regclass) AS expected_owner,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,pg_has_role(current_user,p.proowner,'MEMBER') AS owner_member,has_function_privilege(current_user,p.oid,'EXECUTE') AS executable,has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') AS delegatable,EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure", [proc,table(role.schema,'native_jobs')])).rows[0]
    if (!fn || !fn.expected_owner || !fn.prosecdef || fn.rolsuper || fn.rolbypassrls || fn.owner_member || fn.delegatable || fn.public_execute || !fn.proconfig?.includes('search_path=pg_catalog') || fn.executable !== executable) throw new Error('Unsafe runtime function ownership or privileges')
  }
  if (kind!=='auth' && !(await pool.query(`SELECT ${table(role.schema,'native_schema_matches')}($1::jsonb) AS matched`,[JSON.stringify(await getMigrationManifest())])).rows[0].matched) throw new Error('Runtime schema migrations are not current')
  return { role: role.name as string, schema: role.schema as string }
}

export async function assertSharedDatabase(authPool: Pool, businessPool: Pool) {
  const auth = await authPool.connect()
  let business: PoolClient | undefined, held = false, otherHeld = false
  const key = randomBytes(8).readBigInt64BE().toString()
  try {
    business = await businessPool.connect()
    const a = (await auth.query('SELECT current_database() AS db,current_schema() AS schema')).rows[0]
    const b = (await business.query('SELECT current_database() AS db,current_schema() AS schema')).rows[0]
    if (a.db !== b.db || a.schema !== b.schema) throw new Error('Auth and business connections must share one database and schema')
    await auth.query('SELECT pg_advisory_lock($1::bigint)', [key]); held = true
    otherHeld = (await business.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key])).rows[0].locked
    if (otherHeld) throw new Error('Auth and business connections do not share a database lock manager')
  } finally {
    try { if (otherHeld && business) await business.query('SELECT pg_advisory_unlock($1::bigint)', [key]) }
    finally { try { if (held) await auth.query('SELECT pg_advisory_unlock($1::bigint)', [key]) } finally { business?.release(); auth.release() } }
  }
}
