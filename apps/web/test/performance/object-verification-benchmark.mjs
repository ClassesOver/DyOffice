// Explicit synthetic microbenchmark; not HTTP/DB/storage capacity or a CI threshold.
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { collectVerified, verifyStream } from '../../server/src/storage/object-store.ts'
if (process.argv[2] === '--sample') {
  const mode = process.argv[3], size = Number(process.argv[4]) * 1024 * 1024
  const chunk = Buffer.alloc(64 * 1024, 7), hash = createHash('sha256')
  for (let at = 0; at < size; at += chunk.length) hash.update(chunk)
  const ref = { key: `${randomUUID()}/${randomUUID()}/objects/${randomUUID()}`, size, sha256: hash.digest('hex') }
  global.gc(); const before = process.memoryUsage(); let peak = { ...before }
  function sample() { const now = process.memoryUsage(); for (const key of Object.keys(now)) peak[key] = Math.max(peak[key], now[key]) }
  async function* source() { for (let at = 0; at < size; at += chunk.length) { sample(); yield chunk } }
  const start = performance.now(), result = await (mode === 'collect' ? collectVerified : verifyStream)(source(), ref)
  sample(); const elapsedMs = performance.now() - start
  if ((mode === 'collect' && result.length !== size) || (mode === 'verify' && result !== undefined)) throw new Error('bad output')
  console.log(JSON.stringify({ mode, size, elapsedMs, before, peak, delta: Object.fromEntries(Object.keys(peak).map(k => [k, peak[k] - before[k]])) }))
} else {
  const samples = []
  for (const size of [1, 8, 32]) for (let round = 0; round < 6; round++) for (const mode of (round % 2 ? ['verify', 'collect'] : ['collect', 'verify'])) {
    const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types', import.meta.filename, '--sample', mode, String(size)], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    samples.push({ round, warmup: round === 0, ...JSON.parse(result.stdout) })
  }
  const report = { timestamp: new Date().toISOString(), node: process.version, method: 'Fresh child per sample; single 64KiB reused synthetic source; hash fully checked; no network, database, or load concurrency. First round warmup excluded. Collect matches previous path; verify is candidate. Memory delta includes observed before/after and stream boundaries, not OS high-water.', samples }
  const output = process.env.DYOFFICE_PERFORMANCE_REPORT
  if (output) writeFileSync(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
