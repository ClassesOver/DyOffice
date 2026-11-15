import { readdir, readFile } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const apps = Object.freeze({ docs: 'desktop', sheets: 'desktopApi', slides: 'slidesApi', pdf: 'pdfApi' })
const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx'])
const skipDirs = new Set(['node_modules', 'dist', 'out', 'build', 'assets', 'fonts'])

export function preloadMethodNames(source) {
  // Two-space top-level method entries inside a typed preload API object.
  // The first object is the intended public bridge for these four apps.
  const start = source.search(/^const (?:desktopApi|api): (?:DesktopApi|SlidesApi|PdfApi) = \{/m)
  if (start < 0) return []
  const region = source.slice(start).split(/^\}/m)[0]
  return [...new Set([...region.matchAll(/^  ([a-zA-Z_$][\w$]*)\s*(?::|\()/gm)].map(m => m[1]))].sort()
}

export function rendererMethodNames(source, bridge) {
  const escaped = bridge.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')
  const expression = new RegExp('\\bwindow\\.' + escaped + '\\??\\.([a-zA-Z_$][\\w$]*)', 'g')
  return [...source.matchAll(expression)].map(m => m[1])
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
    if (!preload.includes("contextBridge.exposeInMainWorld('" + bridge + "'")) {
      throw new Error(app + ': expected preload bridge ' + bridge + ' not found')
    }
    const declared = preloadMethodNames(preload)
    if (!declared.length) throw new Error(app + ': no public methods could be parsed')
    const used = new Map()
    const unmatched = new Set()
    const rendererPaths = await sourceFiles(join(base, 'apps', app, 'src/renderer'))
    for (const path of rendererPaths) {
      const contents = await readFile(path, 'utf8')
      for (const name of rendererMethodNames(contents, bridge)) {
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

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL('file://' + process.argv[1]))) {
  try {
    const report = await auditWebHost()
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    console.error('Host inventory failed: ' + error.message)
    process.exitCode = 1
  }
}
