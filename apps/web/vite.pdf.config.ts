import {readFileSync,readdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import react from '@vitejs/plugin-react'
import {defineConfig} from 'vite'
import {workspaceAliases} from './workspace-aliases.mjs'

const web=fileURLToPath(new URL('.',import.meta.url))
const pdfjs=dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
export default defineConfig({
 root:join(web,'pdf'),base:'/native-pdf/',publicDir:false,
 resolve:{alias:workspaceAliases(),dedupe:['react','react-dom','pdf-lib']},
 plugins:[react(),{name:'native-pdf-assets',generateBundle:{order:'post',handler(_options,bundle){
  const inventory=Object.keys(bundle).filter(name=>name.startsWith('assets/'))
  for(const directory of ['cmaps','standard_fonts','wasm']){
   for(const name of readdirSync(join(pdfjs,directory))){
    if(!/\.(bcmap|pfb|ttf|wasm|js)$/.test(name))continue
    const fileName='assets/pdfjs/'+directory+'/'+name
    this.emitFile({type:'asset',fileName,source:readFileSync(join(pdfjs,directory,name))})
    inventory.push(fileName)
   }
  }
  this.emitFile({type:'asset',fileName:'.vite/native-assets.json',source:JSON.stringify(inventory)})
 }}}],
 build:{outDir:join(web,'dist-pdf'),emptyOutDir:true,manifest:true,reportCompressedSize:false},
})
