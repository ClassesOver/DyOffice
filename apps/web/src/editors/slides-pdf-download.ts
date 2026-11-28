import {PDFDocument, PDFHexString} from 'pdf-lib'
import type {ExportPdfLink} from '../../../slides/src/shared/ipc'
import {printPageSizeIn} from '../../../slides/src/shared/print-html'
import {DECK_LINK_PROTOCOLS} from '../../../slides/src/shared/run-link'
import {browserFileName, decodeBrowserBase64, downloadBrowserFile} from './browser-download'

function externalPdfUri(href: string): PDFHexString | undefined {
  let url: URL
  try { url = new URL(href) } catch { return }
  if (!DECK_LINK_PROTOCOLS.includes(url.protocol)) return
  // Opaque URL paths, including mailto addresses, can retain non-ASCII text.
  const uri = url.href.replace(/[^\x00-\x7f]+/g, part => encodeURI(part))
  return PDFHexString.of(Array.from(new TextEncoder().encode(uri),byte=>byte.toString(16).padStart(2,'0')).join(''))
}

export async function buildSlidesPdf(
  pages: string[], widthPx: number, heightPx: number, links: ExportPdfLink[][], signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create()
  const paper = printPageSizeIn('full', undefined, heightPx > 0 ? widthPx / heightPx : NaN)
  const width = paper.width * 72, height = paper.height * 72
  const output = pages.map(() => pdf.addPage([width,height]))
  for (const [index,page] of output.entries()) {
    signal.throwIfAborted()
    const image = await pdf.embedPng(decodeBrowserBase64(pages[index]!))
    page.drawImage(image,{x:0,y:0,width,height})
    for (const link of links[index] ?? []) {
      const left=Math.max(0,link.x),top=Math.max(0,link.y)
      const right=Math.min(1,link.x+link.w),bottom=Math.min(1,link.y+link.h)
      if (!(left<right && top<bottom)) continue
      const anchor = /^#pg(\d+)$/.exec(link.href)
      const destination = anchor && output[Number(anchor[1])-1]
      const uri = destination ? undefined : externalPdfUri(link.href)
      if (!destination && !uri) continue
      const annotation = pdf.context.obj({
        Type:'Annot',Subtype:'Link',Border:[0,0,0],
        Rect:[left*width,(1-bottom)*height,right*width,(1-top)*height],
        ...(destination ? {Dest:[destination.ref,'Fit']} : {A:{Type:'Action',S:'URI',URI:uri!}}),
      })
      page.node.addAnnot(pdf.context.register(annotation))
    }
  }
  return Uint8Array.from(await pdf.save())
}

export function slidesPdfFileName(value:string): string {
  const stem=browserFileName(value.replace(/\.pdf$/i,''),'slides')
  const characters=Array.from(stem.replace(/[\p{Cs}\u202a-\u202e\u2066-\u2069]/gu,'_'))
  const encoder=new TextEncoder()
  while(encoder.encode(characters.join('')+'.pdf').length>255)characters.pop()
  return characters.join('')+'.pdf'
}

export function downloadSlidesPdf(filename:string,bytes:Uint8Array<ArrayBuffer>): string {
  downloadBrowserFile(new Blob([bytes],{type:'application/pdf'}),filename)
  return filename
}
