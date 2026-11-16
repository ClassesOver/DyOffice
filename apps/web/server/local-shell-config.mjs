import { resolve } from 'node:path'

// Opt-in only. A local-account shell must never fall back to shared-token data.
export function localShellDirectory(env) {
  const flag = env.DYOFFICE_LOCAL_SHELL
  const directory = env.DYOFFICE_LOCAL_SHELL_DIR
  if (flag === undefined && directory === undefined) return undefined
  if (env.DYOFFICE_AUTH_MODE !== 'local' || flag !== 'experimental' || typeof directory !== 'string' || !directory.trim()) {
    throw new Error('Local shell requires explicit experimental local mode and a build directory')
  }
  return resolve(directory)
}
