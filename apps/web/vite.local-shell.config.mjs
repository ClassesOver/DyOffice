import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {workspaceAliases} from './workspace-aliases.mjs'
const web=fileURLToPath(new URL('.',import.meta.url))
export default defineConfig({root:`${web}/local-shell`,publicDir:false,plugins:[react()],resolve:{alias:workspaceAliases(),dedupe:['react','react-dom']},build:{assetsInlineLimit:0,outDir:`${web}/dist-local-shell`,emptyOutDir:true,manifest:true}})
