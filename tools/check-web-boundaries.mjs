import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, extname, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules, createRequire } from 'node:module'

// Installed with the small Web workspace, not the Electron workspace graph.
const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const ts = require('typescript')
const root = fileURLToPath(new URL('../', import.meta.url))
const directories = ['apps/web/src', 'apps/web/public', 'packages/browser-host/src', 'packages/web-contracts/src']
const extensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts', '.cjs', '.cts'])
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))

export function forbiddenSpecifier(specifier) {
  specifier = specifier.split(/[?#]/, 1)[0]
  const clean = specifier.replace(/^node:/, '')
  if (specifier.startsWith('node:')) return true
  if (specifier === 'electron' || specifier.startsWith('electron/')) return true
  // These existing renderer helpers contain only browser-safe pure logic.
  // Follow their transitive imports normally; never allow the package root.
  if (['@genoffice/electron-utils/safe-external-url','@genoffice/electron-utils/headless-export'].includes(specifier)) return false
  if (specifier === '@genoffice/electron-utils' || specifier.startsWith('@genoffice/electron-utils/')) return true
  return builtins.has(clean.split('/')[0])
}

function literalSpecifier(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return literalSpecifier(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalSpecifier(node.left), right = literalSpecifier(node.right)
    if (left !== null && right !== null) return left + right
  }
  return null
}

function imports(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly) ||
        (ts.isImportEqualsDeclaration(node) && node.isTypeOnly)) return
    let argument
    let mode = 'import'
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) argument = node.moduleSpecifier
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) argument = node.moduleReference.expression
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) argument = node.arguments[0]
    else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['Worker', 'SharedWorker'].includes(node.expression.text)) {
      const value = node.arguments?.[0]
      // Vite's statically resolved Worker(new URL(path, import.meta.url)).
      if (value && ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'URL' &&
          value.arguments?.[1]?.getText(ast) === 'import.meta.url') argument = value.arguments[0]
      else argument = value
      if (!argument) found.push({specifier: null, mode, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1})
    }
    if (argument) {
      if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require')) mode = 'require'
      found.push({ specifier: literalSpecifier(argument), mode, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

export function inspectSource(source, file) {
  return [...new Set(imports(source, file).filter(({specifier}) => specifier === null || forbiddenSpecifier(specifier))
    .map(({specifier, line}) => specifier === null
      ? `${file}:${line}: Unresolved dynamic browser dependency; use a literal import or explicit literal dispatch`
      : `${file}:${line}: browser code imports forbidden module ${specifier}`))]
}

async function entries(directory) {
  try { return await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function collectFiles(directory) {
  const result = []
  for (const entry of await entries(directory)) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await collectFiles(path))
    else if (entry.isFile() && extensions.has(extname(path))) result.push(path)
  }
  return result
}

async function workspacePackages(base) {
  const packages = new Map()
  for (const group of ['apps', 'packages']) {
    for (const entry of await entries(join(base, group))) {
      if (!entry.isDirectory()) continue
      const directory = join(base, group, entry.name)
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        if (manifest.name) packages.set(manifest.name, { directory, manifest })
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return packages
}

function exportTarget(value, mode) {
  if (typeof value === 'string') return value
  if (!value || Array.isArray(value)) return null
  // Browser conditions with the actual import/require mode; skip types/Node.
  for (const key of Object.keys(value)) {
    if (['browser', mode, 'default'].includes(key)) {
      const target = exportTarget(value[key], mode)
      if (target) return target
    }
  }
  return null
}

async function resolveFile(path) {
  const extension = extname(path)
  const candidates = /\.[cm]?jsx?$/.test(extension)
    ? [path.replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts').replace(/\.jsx?$/, '.ts'), path.replace(/\.jsx?$/, '.tsx'), path]
    : [path]
  if (!extension) candidates.push(...[...extensions].map(ext => path + ext), ...[...extensions].map(ext => join(path, 'index' + ext)))
  for (const candidate of [...new Set(candidates)]) {
    if (!extensions.has(extname(candidate))) continue
    try { if ((await stat(candidate)).isFile()) return candidate }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
  }
  return null
}

async function localDependency(specifier, mode, importer, packages, base) {
  // Match Vite's raw/worker regexes exactly: encoded keys and raw=1 are
  // not raw requests; worker processing takes precedence over asset raw.
  const raw = /(?:\?|&)raw(?:&|$)/.test(specifier)
  const worker = /(?:\?|&)(?:worker|sharedworker)(?:&|$)/.test(specifier)
  if (raw && !worker) return null
  specifier = specifier.split(/[?#]/, 1)[0]
  let target
  if (specifier.startsWith('.')) target = resolve(dirname(importer), specifier)
  else {
    const parts = specifier.split('/')
    const name = parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
    const pkg = packages.get(name)
    if (!pkg) return null // Third-party package bundles remain a build gate.
    const subpath = '.' + specifier.slice(name.length)
    let value = pkg.manifest.exports
    let replacement
    if (value && typeof value === 'object' && Object.keys(value).some(key => key.startsWith('.'))) {
      if (Object.hasOwn(value, subpath)) value = value[subpath]
      else {
        // Node export patterns prefer the longest prefix, then longest key.
        // Resolve the selected target normally so patterns cannot hide Node imports.
        const pattern = Object.keys(value).filter(key => {
          const star = key.indexOf('*')
          return star >= 0 && star === key.lastIndexOf('*') &&
            subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1)) &&
            subpath.length >= key.length - 1
        }).sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)[0]
        if (pattern) {
          const star = pattern.indexOf('*')
          replacement = subpath.slice(star, subpath.length - (pattern.length - star - 1))
          value = value[pattern]
        } else value = null
      }
    }
    else if (subpath !== '.') value = null
    let entry = exportTarget(value, mode)
    if (entry && replacement !== undefined) entry = entry.replaceAll('*', replacement)
    if (!pkg.manifest.exports) entry = subpath === '.' ? (pkg.manifest.module || pkg.manifest.main || './index.js') : subpath
    if (!entry) throw new Error(`Unsupported workspace export ${specifier} imported by ${relative(base, importer)}`)
    target = resolve(pkg.directory, entry)
  }
  const within = relative(base, target)
  if (within === '..' || within.startsWith('..' + sep)) throw new Error(`Browser dependency escapes repository: ${specifier}`)
  // Assets are handled by the production bundler; do not read them as JS.
  if (extname(target) && !extensions.has(extname(target))) return null
  const resolved = await resolveFile(target)
  if (!resolved) throw new Error(`Unresolved local browser dependency ${specifier} imported by ${relative(base, importer)}`)
  return resolved
}

export async function checkWebBoundaries(base = root) {
  base = resolve(base)
  const violations = []
  const visited = new Set()
  const packages = await workspacePackages(base)
  async function visit(file) {
    if (visited.has(file)) return
    visited.add(file)
    const source = await readFile(file, 'utf8')
    violations.push(...inspectSource(source, relative(base, file)))
    for (const {specifier, mode} of imports(source, file)) {
      if (specifier === null || forbiddenSpecifier(specifier)) continue
      const dependency = await localDependency(specifier, mode, file, packages, base)
      if (dependency) await visit(dependency)
    }
  }
  for (const directory of directories) for (const file of await collectFiles(join(base, directory))) await visit(file)
  return { scanned: visited.size, violations }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { scanned, violations } = await checkWebBoundaries()
  for (const violation of violations) console.error(violation)
  console.log(`Web boundary check: scanned ${scanned} files, ${violations.length} violations`)
  if (violations.length) process.exitCode = 1
}
