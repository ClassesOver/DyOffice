import { readdir, readFile } from 'node:fs/promises'
import { join, relative, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const ts = require('typescript')

const root = fileURLToPath(new URL('../', import.meta.url))
const apps = Object.freeze({ docs: 'desktop', sheets: 'desktopApi', slides: 'slidesApi', pdf: 'pdfApi' })
const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx'])
const skipDirs = new Set(['node_modules', 'dist', 'out', 'build', 'assets', 'fonts'])

function parse(source, file = 'source.tsx') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) throw new Error('Cannot parse host inventory source: ' + file)
  return ast
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  if (ts.isComputedPropertyName(node) && ts.isStringLiteral(node.expression)) return node.expression.text
  return null
}

function access(node) {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return { object: node.expression, name: node.argumentExpression.text }
  return null
}

function exposedVariable(ast, bridge) {
  let name
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const method = access(node.expression)
      if (method?.name === 'exposeInMainWorld' && ts.isIdentifier(method.object) && method.object.text === 'contextBridge' &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === bridge &&
          node.arguments[1] && ts.isIdentifier(node.arguments[1])) name = node.arguments[1].text
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return name
}

export function preloadMethodNames(source, bridge) {
  const ast = parse(source, 'preload.ts')
  const exposed = bridge ? exposedVariable(ast, bridge) : undefined
  if (bridge && !exposed) throw new Error('Expected preload bridge ' + bridge + ' not found')
  const names = []
  let found = false
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const matches = exposed ? node.name.text === exposed :
        node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && ['DesktopApi','SlidesApi','PdfApi'].includes(node.type.typeName.text)
      if (matches) {
        if (found) throw new Error('Ambiguous public API objects in preload')
        found = true
        for (const member of node.initializer.properties) {
          const name = member.name && propertyName(member.name)
          if (!name || ts.isSpreadAssignment(member)) throw new Error('Unsupported public API member; inventory cannot be partial')
          names.push(name)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...new Set(names)].sort()
}

export function rendererMethodNames(source, bridge, file = 'renderer.tsx') {
  const names = []
  function visit(node) {
    const method = access(node)
    const api = method && access(method.object)
    if (api?.name === bridge && ts.isIdentifier(api.object) && api.object.text === 'window') names.push(method.name)
    ts.forEachChild(node, visit)
  }
  visit(parse(source, file))
  return names
}

async function sourceFiles(directory) {
  let entries
  try { entries = await readdir(directory, {withFileTypes:true}) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const paths = []
  for (const entry of entries) {
    if (entry.isDirectory() && !skipDirs.has(entry.name)) paths.push(...await sourceFiles(join(directory, entry.name)))
    else if (entry.isFile() && sourceExts.has(extname(entry.name))) paths.push(join(directory, entry.name))
  }
  return paths
}

export async function auditWebHost(base = root) {
  const reports = {}
  for (const [app, bridge] of Object.entries(apps)) {
    const preloadPath = join(base, 'apps', app, 'src/preload/index.ts')
    const preload = await readFile(preloadPath, 'utf8')
    const declared = preloadMethodNames(preload, bridge)
    if (!declared.length) throw new Error(app + ': no public methods could be parsed')
    const used = new Map()
    const unmatched = new Set()
    const rendererPaths = await sourceFiles(join(base, 'apps', app, 'src/renderer'))
    for (const path of rendererPaths) {
      const contents = await readFile(path, 'utf8')
      for (const name of rendererMethodNames(contents, bridge, path)) {
        const item = used.get(name) ?? { count: 0, files: new Set() }
        item.count++
        item.files.add(relative(base, path))
        used.set(name, item)
        if (!declared.includes(name)) unmatched.add(name)
      }
    }
    reports[app] = {
      bridge,
      preload: relative(base, preloadPath),
      declaredCount: declared.length,
      rendererSourceFileCount: rendererPaths.length,
      methods: declared.map(name => ({name, calls: used.get(name)?.count ?? 0, files: [...(used.get(name)?.files ?? [])].sort()})),
      unknownRendererMethods: [...unmatched].sort(),
    }
  }
  return reports
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const report = await auditWebHost()
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    console.error('Host inventory failed: ' + error.message)
    process.exitCode = 1
  }
}
