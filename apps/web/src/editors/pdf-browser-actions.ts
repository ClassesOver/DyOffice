import JSZip from 'jszip'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import type {PdfComparisonReply,PdfComparisonTask} from './pdf-comparison.worker'
import type {ExportImagesRequest} from '../../../pdf/src/shared/ipc'
import {browserFileName, downloadBrowserFile} from './browser-download'

// Retain the engine asset for this viewer. Each file still gets its own worker
// so the PDFium heap can be released as soon as the extraction finishes.
let comparisonEngine:Promise<Blob>|undefined
function loadComparisonEngine(signal?:AbortSignal):Promise<Blob>{
  comparisonEngine??=fetch(wasmUrl,{signal:signal??null}).then(response=>{
    if(!response.ok)throw Error('PDF comparison engine could not load.')
    return response.blob()
  }).catch(error=>{
    comparisonEngine=undefined
    throw error
  })
  return comparisonEngine
}

export async function readPdfComparisonPages(bytes: Uint8Array, password?: string, signal?: AbortSignal): Promise<string[]> {
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('PDF exceeds the comparison size limit.')
  signal?.throwIfAborted()
  const wasm=await loadComparisonEngine(signal)
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./pdf-comparison.worker.ts', import.meta.url), {type:'module'})
  let abort: (()=>void) | undefined
  try {
    const reply=await new Promise<PdfComparisonReply>((resolve,reject)=>{
      abort=()=>reject(signal?.reason)
      signal?.addEventListener('abort',abort,{once:true})
      worker.onmessage=({data}:MessageEvent<PdfComparisonReply>)=>resolve(data)
      worker.onerror=worker.onmessageerror=()=>reject(Error('PDF comparison engine failed.'))
      const task:PdfComparisonTask={bytes,password,wasm}
      worker.postMessage(task,bytes.buffer instanceof ArrayBuffer?[bytes.buffer]:[])
    })
    signal?.throwIfAborted()
    if(!reply.ok)throw Error(reply.error)
    return reply.pages
  } finally {
    if(abort)signal?.removeEventListener('abort',abort)
    worker.terminate()
  }
}

export async function downloadPdfImages({images,pageNumbers,format,baseName}:ExportImagesRequest,signal:AbortSignal):Promise<string> {
  if (!images.length || images.length !== pageNumbers.length || new Set(pageNumbers).size !== pageNumbers.length ||
      pageNumbers.some(page=>!Number.isSafeInteger(page)||page<1) ||
      images.reduce((total,image)=>total+image.length,0)>64*1024*1024) throw new Error('PDF image export exceeds its limits.')
  const header = format === 'jpg' ? '/9j/' : 'iVBORw0KGgo'
  const name = browserFileName(baseName, 'document')
  const zip = new JSZip()
  for (const [index, page] of pageNumbers.entries()) {
    signal.throwIfAborted()
    const image = images[index]!
    if (!image.startsWith(header)) throw new Error('PDF image could not be rendered.')
    zip.file(`${name}-${String(page).padStart(2,'0')}.${format}`,image,{base64:true})
  }
  const archive = await zip.generateAsync({type:'blob',compression:'STORE'})
  signal.throwIfAborted()
  const filename = `${name}-${format}.zip`
  downloadBrowserFile(archive,filename)
  return filename
}
