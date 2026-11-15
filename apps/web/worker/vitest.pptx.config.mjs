import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const dependencies = ['jszip', 'fast-xml-parser', 'utif2', 'opentype.js', 'bidi-js']

const suites = ['apps/slides/tests/pptx-session.test.ts', 'apps/slides/tests/web-worker-roundtrip.test.ts', 'packages/pptx-ops/tests/settext-paragraph-structure.test.ts']
for (const suite of suites) {
  if (!statSync(resolve(root, suite)).isFile()) throw new Error('Missing PPTX suite: ' + suite)
}

// Use current-checkout sources and this harness's lock, without a root/Electron install.
export default {
  root,
  cacheDir: fileURLToPath(new URL('./node_modules/.vite', import.meta.url)),
  plugins: [{
    name: 'native-pptx-sources', enforce: 'pre',
    resolveId(id) {
      if (id.startsWith('@genoffice/')) {
        const [, name, ...parts] = id.split('/')
        const directory = resolve(root, 'packages', name)
        const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
        const key = parts.length ? './' + parts.join('/') : '.'
        const target = typeof manifest.exports === 'string' && key === '.' ? manifest.exports : manifest.exports?.[key]
        if (typeof target !== 'string') throw new Error('Unsupported workspace export: ' + id)
        return resolve(directory, target)
      }
      if (dependencies.includes(id)) return require.resolve(id)
    },
  }],
  test: {
    environment: 'node',
    include: suites,
  },
}
