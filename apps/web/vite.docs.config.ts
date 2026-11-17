import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const web = fileURLToPath(new URL('.',import.meta.url))
export default defineConfig({
  // Native Docs imports React components from sibling workspaces. Keep one dispatcher.
  resolve: { dedupe: ['react', 'react-dom'],alias:[{find:/^@genoffice\/ui$/,replacement:fileURLToPath(new URL('../../packages/ui/src/index.ts',import.meta.url))},{find:/^@genoffice\/agent-core$/,replacement:fileURLToPath(new URL('../../packages/agent-core/src/index.ts',import.meta.url))},{find:/^@genoffice\/ai-provider\/browser$/,replacement:fileURLToPath(new URL('../../packages/ai-provider/src/browser.ts',import.meta.url))}] },
  root: web + '/docs', base: '/native-docx/', publicDir: false, plugins: [react(), { name: 'native-host-inventory', generateBundle(_options,bundle) {
    // Vite's manifest omits module workers; inventory emitted assets only.
    this.emitFile({ type: 'asset', fileName: '.vite/native-assets.json',source: JSON.stringify(Object.keys(bundle).filter(name => name.startsWith('assets/'))) })
  } }],
  build: { outDir: web + '/dist-docs', emptyOutDir: true, manifest: true, sourcemap: false, chunkSizeWarningLimit: 5000 },
})
