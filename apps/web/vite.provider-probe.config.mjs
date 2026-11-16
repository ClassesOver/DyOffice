import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'
import {workspaceAliases} from './workspace-aliases.mjs'
const web=fileURLToPath(new URL('.',import.meta.url))
export default defineConfig({root:`${web}/provider-probe`,base:'/admin/provider-probe/',publicDir:false,resolve:{alias:workspaceAliases()},build:{assetsInlineLimit:0,outDir:`${web}/dist-provider-probe`,emptyOutDir:true,manifest:true,sourcemap:false}})
