import type {PageGeom} from '../../../pdf/src/renderer/annotations'
import {planPdfFormMark,type PdfFormMarkInput} from './pdf-form-marks'
import {buildFormCatalog,type FormField} from '../../../pdf/src/renderer/form-catalog'
import '@genoffice/ui/tokens.css'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { PDF_OPEN_OPTIONS, PDF_VIEWER_CSP } from './pdf-csp.ts'

export { PDF_VIEWER_CSP }

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type OutlineEntry = {title: string; items: OutlineEntry[]}

function outlineTitles(entries: OutlineEntry[] | null): string[] {
  const titles: string[] = []
  const visit = (nodes: OutlineEntry[], depth: number) => {
    for (const node of nodes) {
      if (titles.length >= 200) return
      titles.push('  '.repeat(depth) + node.title.slice(0, 250))
      if (depth < 12) visit(node.items, depth + 1)
    }
  }
  if (entries) visit(entries, 0)
  return titles
}

let library: Promise<Pdfjs> | undefined

function pdfjs(): Promise<Pdfjs> {
  library ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((loaded) => {
    loaded.GlobalWorkerOptions.workerSrc = workerUrl
    return loaded
  })
  return library
}

/** Render PDF pages and saved annotations; mutations are handled by the authorized host. */
export async function mountPdfEditor(
  host: HTMLElement,
  bytes: Uint8Array,
  signal?: AbortSignal,
  rotations?: Readonly<Record<number, number>>,
) {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('PDF_RENDER_LIMIT')
  const check = () => { if (signal?.aborted) throw new DOMException('PDF rendering cancelled', 'AbortError') }
  check()
  const lib = await pdfjs()
  check()
  const task = lib.getDocument({
    data: bytes.slice(),
    ...PDF_OPEN_OPTIONS,
    cMapUrl: new URL('/pdfjs/cmaps/', location.origin).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('/pdfjs/standard_fonts/', location.origin).href,
  })
  let destruction: Promise<void> | undefined
  const destroy = () => destruction ??= Promise.resolve(task.destroy())
  const cancel = () => { void destroy().catch(() => {}) }
  signal?.addEventListener('abort', cancel, {once: true})
  host.replaceChildren()
  const pages: { page: number, width: number, height: number, text: string, annotations: {id:string;type:string;author:string;contents:string;replyTo?:string}[] }[] = []
  const pageGeometries:PageGeom[]=[]
  let outline: string[] = []
  let formFields: FormField[] = []
  try {
    const doc = await task.promise
    check()
    if (doc.numPages > 100) throw new Error('PDF_RENDER_LIMIT')
    let totalPixels = 0
    for (let number = 1; number <= doc.numPages; number += 1) {
      check()
      const page = await doc.getPage(number)
      check()
      const unit=page.userUnit??1,view=page.view
      pageGeometries.push({pw:view?(view[2]-view[0])*unit:page.getViewport({scale:1,rotation:0}).width,ph:view?(view[3]-view[1])*unit:page.getViewport({scale:1,rotation:0}).height,rot:page.rotate??0,x0:view?.[0]??0,y0:view?.[1]??0,userUnit:unit})
      const delta = rotations?.[number] ?? 0
      const viewport = delta
        ? page.getViewport({ scale: 1, rotation: (((page.rotate ?? 0) + delta) % 360 + 360) % 360 })
        : page.getViewport({ scale: 1 })
      const pixels = Math.ceil(viewport.width) * Math.ceil(viewport.height)
      totalPixels += pixels
      if (!Number.isFinite(pixels) || viewport.width <= 0 || viewport.height <= 0 || pixels > 16_000_000 || totalPixels > 64_000_000) throw new Error('PDF_RENDER_LIMIT')
      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page'
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await page.render({ canvas, viewport }).promise
      check()
      const content = await page.getTextContent()
      check()
      const text = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('')
      const caption = document.createElement('p')
      caption.className = 'pdf-text'
      caption.textContent = text
      const figure = document.createElement('figure')
      figure.dataset.pdfPage = String(number)
      const surface=document.createElement('div');surface.className='pdf-page-surface';surface.style.cssText='position:relative;display:table;max-width:100%'
      canvas.style.display='block';canvas.style.maxWidth='100%';canvas.style.height='auto';surface.append(canvas)
      figure.append(surface, caption)
      const annotations=(await page.getAnnotations({intent:'display'})).slice(0,1000).map(annotation=>({id:String(annotation.id??''),type:String(annotation.subtype??''),author:String(annotation.titleObj?.str??''),contents:String(annotation.contentsObj?.str??'').slice(0,4000),...(typeof annotation.inReplyTo==='string'?{replyTo:annotation.inReplyTo}:{})}))
      check()
      const notes=annotations.filter(annotation=>annotation.contents)
      if(notes.length){
        const details=document.createElement('details'),summary=document.createElement('summary')
        summary.textContent=`批注 (${notes.length})`;details.append(summary)
        for(const note of notes){const entry=document.createElement('p');entry.textContent=`${note.author?`${note.author}：`:''}${note.contents}`;details.append(entry)}
        figure.append(details)
      }
      host.append(figure)
      pages.push({ page: number, width: viewport.width, height: viewport.height, text, annotations })
    }
    const catalog=await buildFormCatalog(doc)
    check()
    formFields=[...catalog.fields.values()].map(field=>({...field,options:[...field.options],...(catalog.widgets.find(widget=>widget.fieldName===field.name)?.maxLen!=null?{maxLen:catalog.widgets.find(widget=>widget.fieldName===field.name)!.maxLen!}:{})}))
    outline = outlineTitles(await doc.getOutline?.().catch(() => null) ?? null)
    check()
  } catch (error) {
    if (!signal?.aborted) host.replaceChildren()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
    await destroy()
  }
  return { pages, outline, formFields, pageGeometries }
}

/** Read the current immutable source only; the host applies the planned field or image. */
export async function preparePdfFormMark(bytes:Uint8Array,input:PdfFormMarkInput,signal?:AbortSignal){
 if(bytes.byteLength>64*1024*1024)throw Error('PDF_RENDER_LIMIT')
 signal?.throwIfAborted()
 const lib=await pdfjs()
 signal?.throwIfAborted()
 const task=lib.getDocument({data:bytes.slice(),...PDF_OPEN_OPTIONS,cMapUrl:new URL('/pdfjs/cmaps/',location.origin).href,cMapPacked:true,standardFontDataUrl:new URL('/pdfjs/standard_fonts/',location.origin).href})
 let destruction:Promise<void>|undefined
 const destroy=()=>destruction??=Promise.resolve(task.destroy()),cancel=()=>{void destroy().catch(()=>{})}
 signal?.addEventListener('abort',cancel,{once:true})
 try{
  const doc=await task.promise
  signal?.throwIfAborted()
  if(doc.numPages>100||input.page>doc.numPages)throw Error('PDF_RENDER_LIMIT')
  const catalog=await buildFormCatalog(doc),page=await doc.getPage(input.page)
  signal?.throwIfAborted()
  return await planPdfFormMark(page,input,catalog.byPage.get(input.page-1)??[],signal)
 }finally{signal?.removeEventListener('abort',cancel);await destroy()}
}
