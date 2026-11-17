import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const directory = fileURLToPath(new URL('../apps/web/test/unit/', import.meta.url))
const available = readdirSync(directory).filter(name => /^[A-Za-z0-9_-]+\.test\.mjs$/.test(name)).sort()
const selectors = process.argv.slice(2)
if (!available.length || selectors.some(name => !available.includes(name))) {
  console.error('Invalid unit test selector. Use an existing basename such as host-contract.test.mjs, or no arguments for all unit tests.')
  process.exit(1)
}
const files = selectors.length ? [...new Set(selectors)] : available
const child = spawnSync(process.execPath, ['--experimental-transform-types', '--experimental-test-module-mocks', '--test', ...files], { cwd: directory, stdio: 'inherit' })
if (child.error) console.error(child.error.message)
process.exit(child.status ?? 1)

