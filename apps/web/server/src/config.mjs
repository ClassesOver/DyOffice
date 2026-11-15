const ENVIRONMENTS = new Set(['development', 'test'])
const CONFIG_KEYS = new Set(['env', 'logger', 'rateLimit', 'readyCheck'])

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
  return {
    env: config.env,
    logger: false,
    rateLimit: { max: limit.max, windowMs: limit.windowMs },
    readyCheck: config.readyCheck,
  }
}
