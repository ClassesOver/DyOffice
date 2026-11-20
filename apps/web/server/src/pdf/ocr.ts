import {execFile} from 'node:child_process'
import type {PdfOcrLine} from '../../../../pdf/src/shared/ipc.ts'

export const MAX_OCR_BASE64 = 12 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_OCR_PIXELS = 4096 ** 2
type Box = PdfOcrLine['box']

function parseLines(tsv: string, width: number, height: number): PdfOcrLine[] {
  const lines = new Map<string, PdfOcrLine & {chars: NonNullable<PdfOcrLine['chars']>}>()
  for (const row of tsv.split('\n')) {
    const data = row.split('\t')
    if (data.length < 12 || data[0] !== '5') continue
    const [left, top, w, h, conf] = data.slice(6, 11).map(Number) as [number,number,number,number,number]
    const text = data.slice(11).join('\t').trim()
    if (!text || text.length > 512 || ![left,top,w,h,conf].every(Number.isFinite) ||
      conf < 30 || conf > 100 || left<0 || top<0 || w<=0 || h<=0 || left+w>width || top+h>height) continue
    const box: Box = [left/width, 1-(top+h)/height, (left+w)/width, 1-top/height]
    const key = data.slice(1,5).join(':')
    const line = lines.get(key)
    if (!line) {
      if (lines.size >= 500) break
      lines.set(key,{text, box:[...box], confidence:conf/100, chars:[{text, box}]})
      continue
    }
    if (line.text.length + text.length > 4096) continue
    line.text += ' ' + text
    line.box = [Math.min(line.box[0],box[0]),Math.min(line.box[1],box[1]),Math.max(line.box[2],box[2]),Math.max(line.box[3],box[3])]
    line.chars.push({text:' ',box:[0,0,0,0]},{text,box})
  }
  return [...lines.values()]
}

/** Local OCR for the existing viewer overlay; no external model or file writes. */
export function createPdfOcr() {
  let active = 0
  return async (image: string, signal?: AbortSignal): Promise<PdfOcrLine[] | null> => {
    signal?.throwIfAborted()
    if (image.length > MAX_OCR_BASE64) throw Error('INVALID_IMAGE')
    const png = Buffer.from(image,'base64')
    if (png.length < 33 || !png.subarray(0,8).equals(PNG_SIGNATURE) || png.readUInt32BE(8)!==13 ||
      png.toString('ascii',12,16)!=='IHDR' || png.toString('base64')!==image) throw Error('INVALID_IMAGE')
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    if (!width || !height || width>4096 || height>4096 || width*height>MAX_OCR_PIXELS) throw Error('INVALID_IMAGE')
    if (active>=2) throw Error('OCR_BUSY')
    active++
    try {
      const tsv = await new Promise<string|null>((resolve,reject) => {
        const child = execFile('tesseract',['stdin','stdout','-l','eng+chi_sim','tsv'],{
          signal,timeout:15000,killSignal:'SIGKILL',maxBuffer:512*1024,
          env:{PATH:process.env.PATH,TESSDATA_PREFIX:process.env.TESSDATA_PREFIX,LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH,LANG:'C.UTF-8',OMP_THREAD_LIMIT:'1'},
        },(error,stdout)=>{
          if (!error) resolve(stdout)
          else if (error.code==='ENOENT') resolve(null)
          else reject(Error('OCR_FAILED'))
        })
        child.stdin?.on('error',()=>{/* execFile reports the process outcome. */})
        child.stdin?.end(png)
      })
      signal?.throwIfAborted()
      return tsv===null ? null : parseLines(tsv,width,height)
    } finally {
      active--
    }
  }
}
