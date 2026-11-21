import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {PDF_WORKER_BUNDLE_DIR} from './build-worker-paths.mjs'

const source={url:new URL('./pdf-edit-worker.mjs',import.meta.url),execArgv:['--import','tsx']}
let launch

/** How to fork the PDF edit worker: the prebuilt bundle when every source it was built from is
 * byte-identical to the checkout, otherwise the TypeScript sources through tsx. Decided once per process. */
export function pdfWorkerLaunch(){
  if(launch)return launch
  launch=source
  try{
    const manifest=JSON.parse(readFileSync(resolve(PDF_WORKER_BUNDLE_DIR,'manifest.json'),'utf8'))
    if(manifest?.version!==1||!manifest.inputs||!Object.keys(manifest.inputs).length||!existsSync(resolve(PDF_WORKER_BUNDLE_DIR,'pdf-edit-worker.mjs')))return launch
    for(const [path,digest] of Object.entries(manifest.inputs)){
      if(createHash('sha256').update(readFileSync(resolve(PDF_WORKER_BUNDLE_DIR,path))).digest('hex')!==digest){
        console.warn('dyoffice: PDF worker bundle is stale; using TypeScript sources. Run `npm run build:pdf-worker` in apps/web.')
        return launch
      }
    }
    launch={url:pathToFileURL(resolve(PDF_WORKER_BUNDLE_DIR,'pdf-edit-worker.mjs')),execArgv:[]}
  }catch{/* No bundle (development checkout): use the sources. */}
  return launch
}
