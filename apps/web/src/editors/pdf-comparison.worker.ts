import {init} from '@embedpdf/pdfium'
import {readPdfiumPageText,type PdfiumPageTextReader} from '../../../pdf/src/shared/pdfium-page-text'
import {withPdfDocument,type PdfiumModule} from '../../../../packages/pdf2docx/src/extract/pdfium'

export type PdfComparisonTask={bytes:Uint8Array;wasm:Blob;password?:string|undefined}
export type PdfComparisonReply={ok:true;pages:string[]}|{ok:false;error:string}

const worker=self as unknown as {
 onmessage(event:MessageEvent<PdfComparisonTask>):Promise<void>
 postMessage(reply:PdfComparisonReply):void
}

worker.onmessage=async({data})=>{
 try{
  const runtime=await init({wasmBinary:await data.wasm.arrayBuffer(),thisProgram:'dyoffice-pdf-compare'})
  const engine=runtime.pdfium as unknown as PdfiumModule&PdfiumPageTextReader&{_PDFiumExt_Init():void}
  engine._PDFiumExt_Init()
  const pages=withPdfDocument(engine,data.bytes,doc=>{
   const count=engine._FPDF_GetPageCount(doc)
   if(count>500)throw Error('PDF exceeds the comparison page limit.')
   const result:string[]=[]
   let characters=0
   for(let index=0;index<count;index++){
    const page=engine._FPDF_LoadPage(doc,index)
    if(!page){result.push('');continue}
    try{
     const text=engine._FPDFText_LoadPage(page)
     if(!text){result.push('');continue}
     try{
      const length=engine._FPDFText_CountChars(text)
      if(length>5_000_000-characters)throw Error('PDF exceeds the comparison text limit.')
      const content=readPdfiumPageText(engine,text,length)
      characters+=content.length
      result.push(content)
     }finally{engine._FPDFText_ClosePage(text)}
    }finally{engine._FPDF_ClosePage(page)}
   }
   return result
  },data.password)
  worker.postMessage({ok:true,pages})
 }catch(error){
  worker.postMessage({ok:false,error:error instanceof Error?error.message:'PDF comparison failed.'})
 }
}
