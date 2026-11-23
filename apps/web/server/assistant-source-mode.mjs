/** Office assistant data-source access, from narrowest to widest. */
export const ASSISTANT_SOURCE_MODES = Object.freeze(['off', 'metadata-only', 'read-only-analysis'])

/**
 * Decide the assistant data-source mode from the environment.
 *
 * - Unset: read-only analysis is on by default wherever it can run (local
 *   accounts, a model gateway, source credential keys); otherwise off, so a
 *   deployment without those prerequisites still starts.
 * - Explicit value (including 'off') always wins. An explicit non-off value
 *   with a missing prerequisite fails startup with the missing items named.
 */
export function resolveAssistantSourceMode(env, { authMode }) {
  const explicit = env.DYOFFICE_ASSISTANT_SOURCE_CATALOG
  const missing = []
  if (authMode !== 'local') missing.push('DYOFFICE_AUTH_MODE=local')
  if (!env.DYOFFICE_PROVIDER_GATEWAY_PROFILES && !env.DYOFFICE_CONFIG_KEYRING) missing.push('DYOFFICE_PROVIDER_GATEWAY_PROFILES or DYOFFICE_CONFIG_KEYRING')
  const needsKeys = mode => mode === 'read-only-analysis' && !env.DYOFFICE_SOURCES_CREDENTIAL_KEYS
  if (explicit === undefined || explicit === '') {
    return missing.length || needsKeys('read-only-analysis') ? 'off' : 'read-only-analysis'
  }
  if (!ASSISTANT_SOURCE_MODES.includes(explicit)) {
    throw new Error(`DYOFFICE_ASSISTANT_SOURCE_CATALOG must be one of ${ASSISTANT_SOURCE_MODES.join(', ')}`)
  }
  if (explicit === 'off') return 'off'
  if (needsKeys(explicit)) missing.push('DYOFFICE_SOURCES_CREDENTIAL_KEYS')
  if (missing.length) throw new Error(`Assistant source mode '${explicit}' requires: ${missing.join('; ')}`)
  return explicit
}
