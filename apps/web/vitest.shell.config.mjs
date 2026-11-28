import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
import {workspaceAliases} from './workspace-aliases.mjs';
export default defineConfig({plugins:[react()],resolve:{alias:workspaceAliases(),dedupe:['react','react-dom','pdfjs-dist']},test:{setupFiles:['test/shell/setup.ts'],include:['test/shell/*.test.ts'],environment:'jsdom',environmentOptions:{jsdom:{url:'http://localhost/'}}}});
