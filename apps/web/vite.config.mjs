import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {workspaceAliases} from './workspace-aliases.mjs';

const web = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: `${web}/public`,
  publicDir: false,
  plugins:[react()],
  resolve:{alias:workspaceAliases(),dedupe:['react','react-dom']},
  build: {
    outDir: `${web}/dist`,
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: { workspace: `${web}/public/index.html`, admin: `${web}/public/admin.html`, legacy: `${web}/public/legacy.html`, pdf: `${web}/public/pdf.html` },
    },
  },
});
