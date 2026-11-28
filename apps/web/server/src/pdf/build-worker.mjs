import {build} from 'esbuild'
import {createHash} from 'node:crypto'
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {dirname,relative,resolve} from 'node:path'

import {PDF_WORKER_BUNDLE_DIR} from './build-worker-paths.mjs'
export {PDF_WORKER_BUNDLE_DIR}

/** Pre-transpiles the isolated PDF edit worker so each job fork skips the tsx loader
 * (about 1 s per call).
 * The manifest records a hash of every bundled source; worker-launch.mjs falls back to
 * tsx when any of them changed, so a stale bundle is never executed. */
// The document renderer and its extensions must share the same ProseMirror modules.
const wordDirectory=fileURLToPath(new URL('../../../../docs/',import.meta.url))
const externalNpmPackages={name:'external-npm-packages',setup(build){
  build.onResolve({filter:/^[^./]/},async args=>{
    if(args.pluginData?.resolvingWordEditor)return
    if(/^(?:@tiptap\/|prosemirror-)/.test(args.path)){
      return build.resolve(args.path,{
        resolveDir:wordDirectory,kind:'import-statement',pluginData:{resolvingWordEditor:true},
      })
    }
    // Workspace packages ship TypeScript. Other npm packages resolve at runtime.
    if(!args.path.startsWith('@genoffice/')&&!args.path.startsWith('node:'))return {path:args.path,external:true}
  })
}}

export async function buildPdfWorker(outdir=PDF_WORKER_BUNDLE_DIR){
  await rm(outdir,{recursive:true,force:true})
  await mkdir(outdir,{recursive:true})
  const outfile=resolve(outdir,'pdf-edit-worker.mjs')
  // Code splitting keeps each job's dynamic import lazy; a single file would hoist imports such
  // as the desktop-only `electron` from modules the server never loads.
  const result=await build({
    entryPoints:[fileURLToPath(new URL('./pdf-edit-worker.mjs',import.meta.url))],
    bundle:true,platform:'node',target:'node22',format:'esm',plugins:[externalNpmPackages],
    splitting:true,outdir,entryNames:'[name]',chunkNames:'chunk-[hash]',outExtension:{'.js':'.mjs'},
    metafile:true,logLevel:'warning',
  })
  const inputs={}
  for(const input of Object.keys(result.metafile.inputs).sort()){
    const path=resolve(input)
    inputs[relative(outdir,path)]=createHash('sha256').update(await readFile(path)).digest('hex')
  }
  await writeFile(resolve(outdir,'manifest.json'),JSON.stringify({version:1,inputs},null,1)+'\n')
  return outfile
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const outfile=await buildPdfWorker()
  console.log('Built',relative(process.cwd(),outfile))
}
