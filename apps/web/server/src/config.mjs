const ENVIRONMENTS = new Set(['development', 'test'])
const CONFIG_KEYS = new Set(['env', 'logger', 'rateLimit', 'readyCheck', 'legacy', 'auth'])

/**
 * Rejects production and any field the shell does not understand.
 * Callers cannot inject routes, schemas, or proxy trust through config.
 */
export function assertModularConfig(config) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Modular API shell is not allowed in production')
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Modular API config must be an object')
  }
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`Unsupported modular API config: ${unknown.join(',')}`)
  if (!ENVIRONMENTS.has(config.env)) throw new Error('Modular API shell is not allowed in production')
  if (config.logger !== undefined && config.logger !== false) {
    throw new Error('Unsupported modular API config: logger')
  }
  const limit = config.rateLimit
  if (!limit || typeof limit !== 'object' || Array.isArray(limit)) {
    throw new Error('Modular API rateLimit is invalid')
  }
  const extra = Object.keys(limit).filter((key) => key !== 'max' && key !== 'windowMs')
  if (extra.length > 0) throw new Error(`Unsupported modular API config: ${extra.join(',')}`)
  if (!Number.isInteger(limit.max) || limit.max < 1 || limit.max > 100_000) {
    throw new Error('Modular API rateLimit max is invalid')
  }
  if (!Number.isInteger(limit.windowMs) || limit.windowMs < 1000 || limit.windowMs > 3_600_000) {
    throw new Error('Modular API rateLimit window is invalid')
  }
  if (typeof config.readyCheck !== 'function') throw new Error('Modular API readyCheck must be a function')
  let legacy
  if (config.legacy !== undefined) {
    legacy = config.legacy
    if (!legacy || typeof legacy !== 'object' || typeof legacy.serveStatic !== 'function' || !legacy.store || !legacy.credentials) {
      throw new Error('Unsupported modular API config: legacy')
    }
  }
  let auth
  if (config.auth !== undefined) {
    auth = config.auth
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      throw new Error('Unsupported modular API config: auth')
    }
    const extra = Object.keys(auth).filter((key) => key !== 'authenticate')
    if (extra.length > 0) throw new Error(`Unsupported modular API config: ${extra.join(',')}`)
    if (typeof auth.authenticate !== 'function') {
      throw new Error('Modular API auth.authenticate must be a function')
    }
    auth = { authenticate: auth.authenticate }
  }
  // The legacy store is deployment-global, not scoped by a session principal.
  // Never mount it behind login by merely bypassing the dev-token dispatcher.
  if (auth && legacy) throw new Error('Cannot combine auth and legacy workspace modes')
  return {
    env: config.env,
    logger: false,
    rateLimit: { max: limit.max, windowMs: limit.windowMs },
    readyCheck: config.readyCheck,
    legacy,
    auth,
  }
}
