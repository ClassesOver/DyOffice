// T00 host inventory: every method each editor preload exposes through
// contextBridge, the IPC channels it reaches, and every renderer call site.
//
// Syntax-based (TypeScript AST), not type-based. What it does NOT resolve is
// reported rather than dropped: spread members, computed keys, non-literal
// channels and renderer references to a bridge that are neither a direct
// member access nor a simple alias/destructure ("opaqueReferences").
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const ts = require('typescript')

const root = fileURLToPath(new URL('../', import.meta.url))
export const EDITOR_APPS = Object.freeze(['docs', 'sheets', 'slides', 'pdf'])
const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const skipDirs = new Set(['node_modules', 'dist', 'out', 'build', 'assets', 'fonts'])
const IPC_METHODS = new Set(['invoke', 'send', 'sendSync', 'on', 'once', 'removeListener', 'removeAllListeners', 'postMessage'])

function parse(path, text) {
  const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))) node = node.expression
  return node
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

/** Text of an IPC channel argument: string literal value, or the source text of a constant reference. */
function channelText(arg, sf) {
  if (!arg) return null
  const node = unwrap(arg)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node) || ts.isElementAccessExpression(node)) return '$' + node.getText(sf)
  return '?' + node.getText(sf)
}

function ipcUses(fn, sf) {
  const uses = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const target = callee.expression.text
        const op = callee.name.text
        if (target === 'ipcRenderer' && IPC_METHODS.has(op)) {
          if (op !== 'removeListener' && op !== 'removeAllListeners') uses.push({ op, channel: channelText(node.arguments[0], sf) })
        } else if (target === 'webFrame' || target === 'webUtils' || target === 'clipboard' || target === 'shell') {
          uses.push({ op: target + '.' + op, channel: null })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)
  const key = (u) => u.op + '\u0000' + u.channel
  return [...new Map(uses.map((u) => [key(u), u])).values()].sort((a, b) => key(a).localeCompare(key(b)))
}

/**
 * Lifecycle derived from the IPC operations a member actually performs:
 * subscription (main -> renderer events), request (invoke/sendSync),
 * notify (fire-and-forget send), local (no IPC: in-preload Electron/Node API or constant).
 */
export function lifecycleOf(uses) {
  const ops = new Set(uses.map((u) => u.op))
  if (ops.has('on') || ops.has('once')) return 'subscription'
  if (ops.has('invoke') || ops.has('sendSync')) return 'request'
  if (ops.has('send') || ops.has('postMessage')) return 'notify'
  return 'local'
}

function membersOfObject(obj, sf, objects, seen = new Set()) {
  const members = []
  const unresolved = []
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const inner = unwrap(prop.expression)
      if (ts.isIdentifier(inner) && objects.has(inner.text) && !seen.has(inner.text)) {
        seen.add(inner.text)
        const nested = membersOfObject(objects.get(inner.text), sf, objects, seen)
        members.push(...nested.members)
        unresolved.push(...nested.unresolved)
      } else unresolved.push('...' + prop.expression.getText(sf))
      continue
    }
    const name = prop.name ? propertyName(prop.name) : null
    if (name === null) { unresolved.push(prop.getText(sf).slice(0, 80)); continue }
    let body = prop
    let kind = 'value'
    if (ts.isMethodDeclaration(prop)) kind = 'method'
    else if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) kind = 'accessor'
    else if (ts.isShorthandPropertyAssignment(prop)) { kind = 'reference'; body = prop.name }
    else if (ts.isPropertyAssignment(prop)) {
      const init = unwrap(prop.initializer)
      body = init
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) kind = 'method'
      else if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) kind = 'reference'
    }
    const ipc = ipcUses(body, sf)
    const { line } = sf.getLineAndCharacterOfPosition(prop.getStart(sf))
    members.push({ name, kind, line: line + 1, lifecycle: lifecycleOf(ipc), ipc })
  }
  return { members, unresolved }
}

/** All contextBridge bridges declared in one preload source. */
export function preloadBridges(source, path = 'preload.ts') {
  const sf = parse(path, source)
  const objects = new Map()
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer)
      if (ts.isObjectLiteralExpression(init)) objects.set(node.name.text, init)
    }
    ts.forEachChild(node, collect)
  }
  collect(sf)
  const bridges = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'exposeInMainWorld' && ts.isIdentifier(callee.expression) && callee.expression.text === 'contextBridge') {
        const [nameArg, valueArg] = node.arguments
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        if (!nameArg || !ts.isStringLiteralLike(nameArg)) throw new Error(path + ':' + (line + 1) + ': bridge name is not a string literal')
        const value = valueArg ? unwrap(valueArg) : undefined
        let obj = null
        if (value && ts.isObjectLiteralExpression(value)) obj = value
        else if (value && ts.isIdentifier(value) && objects.has(value.text)) obj = objects.get(value.text)
        const conditional = ts.findAncestor(node.parent, (n) => ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isFunctionLike(n)) !== undefined
        if (obj) {
          const { members, unresolved } = membersOfObject(obj, sf, objects)
          bridges.push({ name: nameArg.text, line: line + 1, conditional, shape: 'object', members, unresolved })
        } else {
          bridges.push({ name: nameArg.text, line: line + 1, conditional, shape: 'value', members: [], unresolved: value && !ts.isLiteralExpression(value) && value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword ? [value.getText(sf).slice(0, 80)] : [] })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  // Top-level preload side effects that are not bridges (e.g. installDropOpenBridge()).
  const sideEffects = []
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue
    const call = unwrap(stmt.expression)
    if (!ts.isCallExpression(call)) continue
    const text = unwrap(call.expression).getText(sf)
    if (text === 'contextBridge.exposeInMainWorld') continue
    sideEffects.push(text)
  }
  return { bridges, sideEffects }
}

const isDeclName = (node) => node.parent && (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isBindingElement(node.parent) || ts.isFunctionDeclaration(node.parent)) && node.parent.name === node

function isPresenceCheck(node) {
  const parent = node.parent
  // React hook dependency list: `useEffect(fn, [bridge])` re-runs on identity, it does not call
  if (ts.isArrayLiteralExpression(parent) && ts.isCallExpression(parent.parent) && parent.parent.arguments.at(-1) === parent && /^(?:React\.)?use[A-Z]\w*$/.test(parent.parent.expression.getText())) return true
  if (ts.isTypeOfExpression(parent) || ts.isIfStatement(parent) || ts.isConditionalExpression(parent) && parent.condition === node) return true
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true
  return ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)
}

/**
 * Renderer references to the given bridges across one program (a set of root
 * files plus whatever they import by relative path). Aliases are resolved by
 * symbol, so unrelated variables with the same name are not confused. A bridge
 * passed as an argument to a function declared in the program is traced into
 * that function's parameter; a concise arrow `() => window.x` makes its callers
 * bridge expressions too. Everything else is returned as an opaque reference.
 */
export function analyzeRenderer(rootPaths, bridgeNames, base = root, paths = {}) {
  const bridges = new Set(bridgeNames)
  const program = ts.createProgram(rootPaths, {
    noLib: true, types: [], allowJs: true, jsx: ts.JsxEmit.Preserve, noEmit: true,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, skipLibCheck: true, baseUrl: base, paths,
  })
  const checker = program.getTypeChecker()
  const files = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/'))
  const valued = new Map() // symbol -> bridge
  const returning = new Map() // function symbol -> bridge
  const traced = new Set() // argument nodes resolved into a parameter
  const symbolOf = (node) => {
    let sym = checker.getSymbolAtLocation(node)
    if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym) } catch { /* unresolved import */ } }
    return sym
  }
  const bridgeOf = (expr) => {
    const node = unwrap(expr)
    if (!node) return null
    if (ts.isPropertyAccessExpression(node)) {
      const obj = unwrap(node.expression)
      if (ts.isIdentifier(obj) && (obj.text === 'window' || obj.text === 'globalThis') && bridges.has(node.name.text)) return node.name.text
      return null
    }
    if (ts.isIdentifier(node)) { const sym = symbolOf(node); return (sym && valued.get(sym)) ?? null }
    if (ts.isCallExpression(node)) { const sym = symbolOf(unwrap(node.expression)); return (sym && returning.get(sym)) ?? null }
    // `window.x ?? {}` / `window.x || fallback`: the bridge when present
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return bridgeOf(node.left)
    return null
  }
  /** The single returned expression of `() => expr`, `() => { return expr }` or `function f() { return expr }`. */
  const returnedExpr = (fn) => {
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) || !fn.body) return null
    if (!ts.isBlock(fn.body)) return fn.body
    const [only, ...rest] = fn.body.statements
    return !rest.length && only && ts.isReturnStatement(only) ? only.expression ?? null : null
  }
  const functionOf = (callee) => {
    const target = unwrap(callee)
    const sym = symbolOf(ts.isPropertyAccessExpression(target) ? target.name : target)
    let decl = sym?.valueDeclaration ?? sym?.declarations?.[0]
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) decl = unwrap(decl.initializer)
    return decl && ts.isFunctionLike(decl) && !decl.getSourceFile().isDeclarationFile ? decl : null
  }
  const calls = []
  const opaque = []
  const where = (node) => { const sf = node.getSourceFile(); return { file: relative(base, sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 } }
  const recordPattern = (pattern, bridge, out) => {
    for (const el of pattern.elements) {
      const key = el.propertyName ? propertyName(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : null
      if (el.dotDotDotToken || key === null) out.opaque.push({ bridge, ...where(el), text: el.getText() })
      else out.calls.push({ bridge, method: key, ...where(el) })
    }
  }
  // fixpoint: propagate bridge values through aliases, parameters and accessor functions
  for (let changed = true, round = 0; changed && round < 8; round++) {
    changed = false
    const mark = (map, sym, bridge) => { if (sym && !map.has(sym)) { map.set(sym, bridge); changed = true } }
    for (const sf of files) {
      const visit = (node) => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
          const bridge = bridgeOf(node.initializer)
          if (bridge) mark(valued, symbolOf(node.name), bridge)
          const b = bridgeOf(returnedExpr(unwrap(node.initializer)))
          if (b) mark(returning, symbolOf(node.name), b)
        }
        if (ts.isFunctionDeclaration(node) && node.name) { const b = bridgeOf(returnedExpr(node)); if (b) mark(returning, symbolOf(node.name), b) }
        if (ts.isCallExpression(node)) {
          node.arguments.forEach((arg, i) => {
            const bridge = bridgeOf(arg)
            if (!bridge) return
            const fn = functionOf(node.expression)
            const param = fn?.parameters[i]
            if (!param || param.dotDotDotToken) return
            traced.add(arg)
            if (ts.isIdentifier(param.name)) mark(valued, symbolOf(param.name), bridge)
          })
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
  }
  const out = { calls, opaque }
  // the returned expression of a function already recorded as returning a bridge
  const isAccessorResult = (node) => {
    let expr = node
    while (expr.parent && ts.isBinaryExpression(expr.parent) && expr.parent.left === expr) expr = expr.parent
    while (expr.parent && (ts.isParenthesizedExpression(expr.parent) || ts.isAsExpression(expr.parent))) expr = expr.parent
    const owner = ts.isReturnStatement(expr.parent) ? ts.findAncestor(expr.parent, ts.isFunctionLike) : expr.parent
    if (!owner || !ts.isFunctionLike(owner) || unwrap(returnedExpr(owner)) !== unwrap(expr)) return false
    const name = ts.isFunctionDeclaration(owner) ? owner.name : ts.isVariableDeclaration(owner.parent) ? owner.parent.name : null
    return !!name && returning.has(symbolOf(name))
  }
  for (const sf of files) {
    const visit = (node) => {
      if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isImportDeclaration(node) || ts.isExportSpecifier(node)) return
      const bridge = ts.isExpression(node) && !isDeclName(node) ? bridgeOf(node) : null
      if (!bridge) { ts.forEachChild(node, visit); return }
      const parent = node.parent
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        calls.push({ bridge, method: parent.name.text, ...where(parent) })
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteralLike(parent.argumentExpression)) {
        calls.push({ bridge, method: parent.argumentExpression.text, ...where(parent) })
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
        recordPattern(parent.name, bridge, out)
      } else if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
        const fn = traced.has(node) ? functionOf(parent.expression) : null
        const param = fn?.parameters[parent.arguments.indexOf(node)]
        if (param && ts.isObjectBindingPattern(param.name)) recordPattern(param.name, bridge, out)
        else if (!param) opaque.push({ bridge, ...where(node), text: parent.getText().slice(0, 120) })
      } else if (!(ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name))
        && !isAccessorResult(node)
        && !(ts.isBinaryExpression(parent) && parent.left === node && bridgeOf(parent))
        && !isPresenceCheck(node)) {
        opaque.push({ bridge, ...where(node), text: parent.getText().slice(0, 120) })
      }
      // arguments of a bridge call can contain further bridge references
      if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { calls, opaque, programFiles: files.map((sf) => relative(base, sf.fileName)).sort() }
}

async function sourceFiles(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const paths = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && !skipDirs.has(entry.name)) paths.push(...await sourceFiles(join(directory, entry.name)))
    else if (entry.isFile() && sourceExts.has(extname(entry.name)) && !entry.name.endsWith('.d.ts')) paths.push(join(directory, entry.name))
  }
  return paths
}

/** TypeScript `paths` for workspace packages, from each package.json's exact string `exports`. */
export async function workspacePaths(base = root) {
  const paths = {}
  let dirs
  try { dirs = await readdir(join(base, 'packages'), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return paths; throw error }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    let pkg
    try { pkg = JSON.parse(await readFile(join(base, 'packages', dir.name, 'package.json'), 'utf8')) } catch { continue }
    if (typeof pkg.name !== 'string') continue
    const exportsMap = typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports ?? (pkg.main ? { '.': pkg.main } : {})
    for (const [key, value] of Object.entries(exportsMap)) {
      const target = typeof value === 'string' ? value : value && (value.browser ?? value.import ?? value.default)
      if (typeof target !== 'string' || key.includes('*') || !/\.(?:[cm]?[jt]sx?)$/.test(target)) continue
      paths[pkg.name + (key === '.' ? '' : key.slice(1))] = [join('packages', dir.name, target)]
    }
  }
  return paths
}

export async function auditWebHost(base = root) {
  const reports = {}
  const paths = await workspacePaths(base)
  for (const app of EDITOR_APPS) {
    const preloadPath = join(base, 'apps', app, 'src/preload/index.ts')
    const { bridges, sideEffects } = preloadBridges(await readFile(preloadPath, 'utf8'), relative(base, preloadPath))
    if (!bridges.length) throw new Error(app + ': no contextBridge.exposeInMainWorld bridge found')
    const names = new Set(bridges.map((b) => b.name))
    if (names.size !== bridges.length) throw new Error(app + ': a bridge name is exposed twice')
    const used = new Map()
    const unknown = new Map()
    const rendererPaths = await sourceFiles(join(base, 'apps', app, 'src/renderer'))
    const { calls, opaque: opaqueReferences, programFiles } = analyzeRenderer(rendererPaths, names, base, paths)
    for (const { bridge, method, file } of calls) {
      const id = bridge + '.' + method
      const item = used.get(id) ?? { count: 0, files: new Set() }
      item.count++
      item.files.add(file)
      used.set(id, item)
    }
    for (const bridge of bridges) {
      const declared = new Set(bridge.members.map((m) => m.name))
      for (const [id, item] of used) {
        const [b, method] = [id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1)]
        if (b === bridge.name && !declared.has(method)) unknown.set(id, [...item.files].sort())
      }
      for (const m of bridge.members) {
        const item = used.get(bridge.name + '.' + m.name)
        m.calls = item?.count ?? 0
        m.files = [...(item?.files ?? [])].sort()
      }
    }
    reports[app] = {
      preload: relative(base, preloadPath),
      rendererSourceFileCount: rendererPaths.length,
      analyzedFileCount: programFiles.length,
      bridges,
      preloadSideEffects: sideEffects,
      declaredCount: bridges.reduce((n, b) => n + b.members.length, 0),
      unknownRendererMethods: [...unknown.keys()].sort(),
      opaqueReferences,
    }
  }
  return reports
}

/** Flat `app/bridge.member` rows, the key space of the classification file. */
export function inventoryRows(report) {
  const rows = []
  for (const [app, r] of Object.entries(report)) {
    for (const b of r.bridges) for (const m of b.members) rows.push({ id: app + '/' + b.name + '.' + m.name, app, bridge: b.name, ...m })
  }
  return rows
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = await auditWebHost()
    if (process.argv.includes('--summary')) {
      for (const [app, r] of Object.entries(report)) {
        const unused = r.bridges.flatMap((b) => b.members).filter((m) => !m.calls).length
        console.log(app + ': ' + r.bridges.map((b) => b.name + '(' + b.members.length + ')').join(' ') + '; ' + r.declaredCount + ' members, ' + unused + ' without renderer call, ' + r.unknownRendererMethods.length + ' unmatched, ' + r.opaqueReferences.length + ' opaque')
      }
    } else console.log(JSON.stringify(report, null, 2))
    const unresolved = Object.values(report).flatMap((r) => r.bridges.flatMap((b) => b.unresolved))
    if (Object.values(report).some((r) => r.unknownRendererMethods.length) || unresolved.length) process.exitCode = 1
  } catch (error) {
    console.error('Host inventory failed: ' + error.message)
    process.exitCode = 1
  }
}
