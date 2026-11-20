import {parentPort,workerData} from 'node:worker_threads'
import {isBackgroundFormat} from './background-format.ts'
try {
 const format:unknown=workerData.format
 if(typeof format!=='string'||!isBackgroundFormat(format))throw Error('Unsupported background format')
 // Extract in the bounded worker before slicing, so truncated always describes actual text.
 const bytes=new Uint8Array(workerData.bytes)
 const zip=bytes[0]===0x50&&bytes[1]===0x4b
 if(format==='pdf'?!Buffer.from(bytes).subarray(0,1024).includes(Buffer.from('%PDF-')):!zip)throw Error('Document format mismatch')
 let text:string
 switch(format){
  case 'docx':text=await (await import('../../../../../../packages/file-parse/src/docx.ts')).docxToText(bytes);break
  case 'xlsx':text=await (await import('../../../../../../packages/file-parse/src/xlsx.ts')).xlsxToText(bytes);break
  case 'pptx':text=await (await import('../../../../../../packages/file-parse/src/pptx.ts')).pptxToText(bytes);break
  case 'pdf':text=await (await import('../../../../../../packages/file-parse/src/pdf.ts')).pdfToText(bytes);break
 }
 parentPort!.postMessage({text:text.slice(0,24000),truncated:text.length>24000})
}catch {parentPort!.postMessage({error:true})}
