// QA only; never called by production build or app registration.
import { build } from 'esbuild'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
const root = resolve('.'),
  alias = {}
for (const dir of await readdir('packages')) {
  try {
    const p = JSON.parse(await readFile(`packages/${dir}/package.json`, 'utf8'))
    if (!p.name) continue
    const exports = p.exports
    if (typeof exports === 'string') alias[p.name] = resolve('packages', dir, exports)
    else if (exports && typeof exports === 'object') {
      for (const [key, value] of Object.entries(exports)) {
        if (!key.startsWith('.')) throw Error('Unsupported conditional root exports ' + p.name)
        if (typeof value !== 'string') throw Error('Explicit export map required ' + p.name + key)
        if (key.endsWith('/*') && value.endsWith('/*'))
          alias[p.name + key.slice(1, -2)] = resolve('packages', dir, value.slice(0, -2))
        else if (key === './*' && value === './src/*.ts') {
          for (const f of await readdir(resolve('packages', dir, 'src')))
            if (f.endsWith('.ts'))
              alias[p.name + '/' + f.slice(0, -3)] = resolve('packages', dir, 'src', f)
        } else if (key.includes('*') || value.includes('*'))
          throw Error('Unsupported export wildcard')
        else alias[p.name + (key === '.' ? '' : key.slice(1))] = resolve('packages', dir, value)
      }
    } else if (p.module || p.main) alias[p.name] = resolve('packages', dir, p.module ?? p.main)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}
const result = await build({
  entryPoints: ['qa-controlled/editor.ts', 'qa-controlled/login.ts', 'qa-controlled/recovery.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  alias,
  loader: {
    '.css': 'css',
    '.png': 'file',
    '.svg': 'file',
    '.jpg': 'file',
    '.woff': 'file',
    '.woff2': 'file',
  },
  outdir: 'qa-controlled/dist',
  metafile: true,
})
const outside = Object.keys(result.metafile.inputs).filter((p) => {
  const r = relative(root, resolve(p))
  return r.startsWith('..') || isAbsolute(r)
})
const bad = outside.filter((p) => !p.includes('/node_modules/'))
if (bad.length) throw Error('Outside candidate workspace source: ' + JSON.stringify(bad))
await writeFile('qa-controlled/metafile.json', JSON.stringify(result.metafile, null, 2))
await writeFile(
  'qa-controlled/resolution.json',
  JSON.stringify({ alias, thirdPartyOutside: outside }, null, 2),
)
console.log(
  'Controlled QA bundle built: candidate workspace source fenced; third-party outside paths recorded. Not production-mounted.',
)
