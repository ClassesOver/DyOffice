// Failure-only, read-only evidence. Do not log SQL, parameters, credentials,
// arbitrary application names, client addresses or database/role names.
export async function databaseCleanupError(admin, database) {
  let backends
  try {
    backends = (await admin.query({ text: `SELECT pid,backend_type,
      CASE WHEN application_name='dyoffice-source-reader' THEN 'source-reader'
        WHEN application_name LIKE 'dyoffice-rls-%-business' THEN 'business'
        WHEN application_name LIKE 'dyoffice-rls-%-auth' THEN 'auth'
        WHEN application_name LIKE 'dyoffice-rls-%-owner' THEN 'owner'
        WHEN application_name LIKE 'dyoffice-rls-%-worker' THEN 'worker'
        ELSE 'other' END AS application,
      state,wait_event_type,wait_event,
      EXTRACT(EPOCH FROM (clock_timestamp()-backend_start))::integer AS backend_age_seconds,
      EXTRACT(EPOCH FROM (clock_timestamp()-xact_start))::integer AS transaction_age_seconds,
      EXTRACT(EPOCH FROM (clock_timestamp()-state_change))::integer AS state_age_seconds
      FROM pg_stat_activity WHERE datname=$1 ORDER BY pid LIMIT 20`, values: [database], query_timeout: 1000 })).rows
  } catch { backends = [{ diagnostic: 'unavailable' }] }
  return new Error('Test database still has open connections after pool shutdown; backends=' + JSON.stringify(backends))
}
