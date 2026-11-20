/** Built-in coding is opt-out; runtime validation remains lazy at task execution. */
export function codingHarnessConfig(env) {
  if (env.DYOFFICE_CODING_AGENT === 'off') return false
  return {
    ...(env.DYOFFICE_CODEX_PATH ? { cliPath: env.DYOFFICE_CODEX_PATH } : {}),
    ...(env.DYOFFICE_ANALYSIS_PYTHON ? { analysisPython: env.DYOFFICE_ANALYSIS_PYTHON } : {}),
  }
}
