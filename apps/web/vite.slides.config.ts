import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const web = fileURLToPath(new URL('.',import.meta.url))
export default defineConfig({
  root: web + '/slides', base: '/native-pptx/', publicDir: false, plugins: [react(), { name: 'native-host-inventory', generateBundle: { order: 'post', handler(_options,bundle) {
    // Run after Vite's HTML hook removes unused entry facades. An early
    // inventory can list deleted chunks and make strict static startup fail.
    // Vite's manifest omits module workers; inventory emitted assets only.
    this.emitFile({ type: 'asset', fileName: '.vite/native-assets.json',source: JSON.stringify(Object.keys(bundle).filter(name => name.startsWith('assets/'))) })
  } } }],
  build: { reportCompressedSize: false, rollupOptions: { preserveEntrySignatures: 'strict', output: {manualChunks(id) { if (id.includes('/node_modules/konva/')) return 'konva' }} }, outDir: web + '/dist-slides', emptyOutDir: true, manifest: true, sourcemap: false, chunkSizeWarningLimit: 5000 },
})
