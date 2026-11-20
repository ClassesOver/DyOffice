import type {AgentSkill} from '@genoffice/agent-core'
import type {createPdfExtraction} from './pdf-extraction'
import {parsePdfPageRanges} from '../shell/pdf-page-inputs'

export function createNativePdfPageCopies(copies:ReturnType<typeof createPdfExtraction>,savedPageCount:()=>number|undefined,canConfirm=()=>true):AgentSkill{
 return {
  id:'native-pdf-page-copies',
  systemPrompt:'These tools create separate files from the current saved PDF without modifying the source. If there are unsaved edits, ask the user to save or discard them first. If publication cannot be confirmed, use confirm_pdf_copies to resume the existing batch instead of issuing another creation request.',
  tools:[
   {name:'extract_pages',description:'Save and open a new PDF with the selected source pages in source order. Use a 1-based range such as "1-3,5".',inputSchema:{type:'object',additionalProperties:false,properties:{pages:{type:'string',minLength:1}},required:['pages']}},
   {name:'split_pdf',description:'Split the current PDF into 2 to 100 new files in source order; the last part may be shorter.',inputSchema:{type:'object',additionalProperties:false,properties:{pages_per_file:{type:'integer',minimum:1}},required:['pages_per_file']}},
   {name:'split_pages',description:'Cut every page into a 2, 4 or 9 cell grid in a new PDF, with at most 100 output pages. Hidden content remains; this is not redaction.',inputSchema:{type:'object',additionalProperties:false,properties:{per_page:{type:'integer',enum:[2,4,9]}},required:['per_page']}},
   {name:'merge_pages',description:'Arrange pages from the current PDF onto sheets of a new PDF. Interactive annotations are not copied. This does not combine multiple source files.',inputSchema:{type:'object',additionalProperties:false,properties:{per_sheet:{type:'integer',minimum:2,maximum:16},direction:{type:'string',enum:['horizontal','vertical'],default:'vertical'},separator:{type:'boolean',default:false}},required:['per_sheet']}},
   {name:'confirm_pdf_copies',description:'Confirm and open the remaining files from an interrupted PDF copy operation. Does not regenerate pages.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  ],
  async executeTool(call,signal){
   signal?.throwIfAborted()
   const summary='PDF page copies'
   const fail=(output:string)=>({output,summary,isError:true,mutated:false})
   const input=call.input as Record<string,unknown>|null
   if(!input||typeof input!=='object'||Array.isArray(input))return fail('Invalid PDF copy request.')
   try{
    let ok:boolean
    if(call.name==='confirm_pdf_copies'){
     if(!canConfirm())return fail('Confirm the redacted copy in the review panel.')
     if(Object.keys(input).length||!copies.hasPending())return fail('There is no pending PDF copy batch to confirm.')
     ok=await copies.confirm(signal)
    }else{
     if(copies.hasPending())return fail('Confirm the previous PDF copy batch with confirm_pdf_copies before creating more files.')
     const count=savedPageCount()
     if(!count)return fail('Save or discard PDF changes before creating copies.')
     if(call.name==='extract_pages'){
      const pages=parsePdfPageRanges(input.pages,count)
      if(!pages||Object.keys(input).length!==1)return fail('Select existing pages using a range such as 1-3,5.')
      ok=await copies.extract(pages,signal)
     }else if(call.name==='split_pdf'){
      const size=input.pages_per_file
      if(typeof size!=='number'||!Number.isSafeInteger(size)||size<1||size>=count||Math.ceil(count/size)>100||Object.keys(input).length!==1)return fail('pages_per_file must produce 2 to 100 files.')
      ok=await copies.split(size,signal)
     }else if(call.name==='split_pages'){
      const size=input.per_page
      if((size!==2&&size!==4&&size!==9)||count*size>100||Object.keys(input).length!==1)return fail('Choose 2, 4 or 9 cells per page and at most 100 output pages.')
      ok=await copies.layout({kind:'split',perPage:size},signal)
     }else if(call.name==='merge_pages'){
      const size=input.per_sheet,direction=input.direction===undefined?'vertical':input.direction,separator=input.separator===undefined?false:input.separator
      if(typeof size!=='number'||!Number.isSafeInteger(size)||size<2||size>16||Math.ceil(count/size)>100||(direction!=='horizontal'&&direction!=='vertical')||typeof separator!=='boolean'||Object.keys(input).some(key=>!['per_sheet','direction','separator'].includes(key)))return fail('Choose 2 to 16 pages per sheet, a horizontal or vertical direction, and a boolean separator.')
      ok=await copies.layout({kind:'merge',perSheet:size,direction,separator},signal)
     }else return fail('Unavailable PDF copy tool.')
    }
    if(!ok)return fail('PDF copy operation is busy or unavailable.')
    const receipts=copies.getReceipts().map(({fileId,revision})=>({fileId,revision}))
    return {output:`Saved and opened ${receipts.length} PDF file(s): ${JSON.stringify(receipts)}. Source PDF is unchanged.`,summary,mutated:true}
   }catch(error){
    signal?.throwIfAborted()
    if(copies.hasPending()){
     const {created,total}=copies.getProgress()
     return fail(`PDF copy batch incomplete (${created}/${total} save receipts received). Use confirm_pdf_copies to resume without generating duplicates.`)
    }
    return fail(error instanceof Error?error.message:'Could not confirm PDF copies. Check workspace files before retrying.')
   }
  },
 }
}
