import { readdir, readFile } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'

const root = fileURLToPath(new URL('../', import.meta.url))
const directories = ['apps/web/src', 'apps/web/public', 'packages/browser-host/src', 'packages/web-contracts/src']
const extensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts'])
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const importPatterns = [
  /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
]

export function forbiddenSpecifier(specifier) {
  const clean = specifier.replace(/^node:/, '')
  if (specifier === 'electron' || specifier.startsWith('electron/')) return true
  if (specifier === '@genoffice/electron-utils' || specifier.startsWith('@genoffice/electron-utils/')) return true
  return builtins.has(clean.split('/')[0])
}

export function inspectSource(source, file) {
  const violations = []
  for (const pattern of importPatterns) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      if (!forbiddenSpecifier(match[1])) continue
      const line = source.slice(0, match.index).split('\n').length
      const message = `${file}:${line}: browser code imports forbidden module ${match[1]}`
      if (!violations.includes(message)) violations.push(message)
    }
  }
  return violations
}

async function collectFiles(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const result = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await collectFiles(path))
    else if (entry.isFile() && extensions.has(extname(path))) result.push(path)
  }
  return result
}

export async function checkWebBoundaries(base = root) {
  const violations = []
  let scanned = 0
  for (const directory of directories) {
    for (const file of await collectFiles(join(base, directory))) {
      scanned++
      violations.push(...inspectSource(await readFile(file, 'utf8'), relative(base, file)))
    }
  }
  return { scanned, violations }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const { scanned, violations } = await checkWebBoundaries()
  for (const violation of violations) console.error(violation)
  console.log(`Web boundary check: scanned ${scanned} files, ${violations.length} violations`)
  if (violations.length) process.exitCode = 1
}
