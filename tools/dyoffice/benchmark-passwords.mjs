import { performance } from 'node:perf_hooks'
import { cpus } from 'node:os'
import { createPasswordService } from '../../apps/web/server/src/modules/auth/passwords.ts'

const service = await createPasswordService()
const password = 'synthetic benchmark lanterns over quiet rivers 8246'
const encoded = await service.hash(password)
const samples = { hash: [], wrong: [], unknown: [] }
for (let i = 0; i < 12; i++) {
  for (const kind of (i % 2 ? ['unknown', 'wrong', 'hash'] : ['hash', 'wrong', 'unknown'])) {
    const start = performance.now()
    if (kind === 'hash') await service.hash(password)
    else await service.verifyCandidate('incorrect synthetic benchmark phrase', kind === 'wrong' ? encoded : undefined)
    samples[kind].push(performance.now() - start)
  }
}
const elapsed = performance.now()
await Promise.all([service.hash(password), service.hash(password)])
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { count: values.length, meanMs: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)), medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)) }
}
console.log(JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
  argon2id: { memoryKiB: 19456, iterations: 2, parallelism: 1 }, maxConcurrent: 2,
  samples: Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, stats(value)])),
  twoConcurrentHashesMs: Number((performance.now() - elapsed).toFixed(2)), peakRssKiB: process.resourceUsage().maxRSS,
  limitation: 'Local synthetic measurement; not a production capacity or timing non-enumeration proof. HTTP throttles and account sessions remain separate gates.',
}, null, 2))
