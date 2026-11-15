import { spawnSync } from 'node:child_process'

const file = process.argv[2]
if (process.argv.length !== 3 || !/^test\/integration\/[A-Za-z0-9._/-]+\.test\.mjs$/.test(file) || file.includes('..')) {
  console.error('Usage: npm run test:web:integration -- test/integration/<name>.test.mjs')
  console.error('Runs one file under apps/web/test/integration. api-compat is HTTP-only and does not use PostgreSQL, S3, or Redis.')
  process.exit(1)
}

const child = spawnSync(process.execPath, ['--test', file], { stdio: 'inherit' })
process.exit(child.status === null ? 1 : child.status)
