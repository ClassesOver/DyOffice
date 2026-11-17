import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Vite-style `*.md?raw` text imports (the pptx-ops op guides): tsx's resolver
// strips the ?raw query and its synchronous load hook rejects .md parts, so a
// synchronous hook registered after tsx short-circuits every .md part into a
// default-exported text module. Child-process support only; the API process
// never imports pptx-ops.
registerHooks({
  load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith('.md')) {
      const text = readFileSync(fileURLToPath(url), 'utf8')
      return { format: 'module', source: 'export default ' + JSON.stringify(text), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
