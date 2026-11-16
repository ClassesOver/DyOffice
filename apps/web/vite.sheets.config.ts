import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const web = fileURLToPath(new URL('.',import.meta.url))
export default defineConfig({
  root: web + '/sheets', base: '/native-xlsx/', publicDir: false, plugins: [react(), { name: 'native-host-inventory', generateBundle(_options,bundle) {
    // Vite's manifest omits module workers; inventory emitted assets only.
    this.emitFile({ type: 'asset', fileName: '.vite/native-assets.json',source: JSON.stringify(Object.keys(bundle).filter(name => name.startsWith('assets/'))) })
  } }],
  build: { reportCompressedSize: false, rollupOptions: { preserveEntrySignatures: 'strict', output: {manualChunks(id) { if (id.includes('/node_modules/@univerjs/')) return 'univer' }} }, outDir: web + '/dist-sheets', emptyOutDir: true, manifest: true, sourcemap: false, chunkSizeWarningLimit: 5000 },
})
