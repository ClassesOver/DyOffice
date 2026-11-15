import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const web = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: `${web}/public`,
  publicDir: false,
  build: {
    outDir: `${web}/dist`,
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: { workspace: `${web}/public/index.html`, admin: `${web}/public/admin.html` },
    },
  },
});
