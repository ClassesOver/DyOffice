import type {AgentSkill} from '@genoffice/agent-core'
import {isRevisionRef,type RevisionRef} from '../../../../packages/web-contracts/src/api'

export type PdfCreatedDocumentInput={type:'pdf'|'docx';title:string;content:string}
export type PreparedAiDocumentCreator={docxEditable:boolean;save:(input:PdfCreatedDocumentInput&{file?:Blob},signal?:AbortSignal)=>Promise<RevisionRef>}
export type PdfDocumentCreator=(input:PdfCreatedDocumentInput,signal?:AbortSignal)=>Promise<RevisionRef>

/** Bind identity before font loading/rendering; an uncertain write must never regenerate a file. */
export function createPdfDocumentCreator(options:{
 prepare:(signal?:AbortSignal)=>Promise<PreparedAiDocumentCreator>
 loadFont?:()=>Promise<Uint8Array>
 renderPdf?:(title:string,content:string,font:Uint8Array)=>Promise<Uint8Array>
}):PdfDocumentCreator{
 let busy=false,unconfirmed=false
 return async(input,signal)=>{
  if(unconfirmed)throw Error('Creation is not confirmed. Check the workspace files before creating another document; do not repeat this request.')
  if(busy)throw Error('Document creation is in progress.')
  busy=true
  try{
   signal?.throwIfAborted()
   const prepared=await options.prepare(signal)
   signal?.throwIfAborted()
   if(input.type==='docx'&&!prepared.docxEditable)throw Error('DOCX creation is unavailable in this workspace.')
   let file:Blob|undefined
   if(input.type==='pdf'){
    const font=await (options.loadFont??(async()=>{
     const response=await fetch(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url),{signal})
     if(!response.ok)throw Error('PDF font unavailable.')
     return new Uint8Array(await response.arrayBuffer())
    }))()
    signal?.throwIfAborted()
    const render=options.renderPdf??(await import('../editors/create-ai-pdf')).createAiPdf
    const bytes=await render(input.title,input.content,font)
    signal?.throwIfAborted()
    file=new Blob([new Uint8Array(bytes).buffer as ArrayBuffer],{type:'application/pdf'})
   }
   signal?.throwIfAborted()
   // Any error after entering save may follow a successful remote write, even a late 401/403/409.
   unconfirmed=true
   const receipt=await prepared.save({...input,...(file?{file}:{})},signal)
   if(!isRevisionRef(receipt)||receipt.size<1)throw Error('The created document has no confirmed saved revision.')
   unconfirmed=false
   return receipt
  }finally{busy=false}
 }
}

export function createPdfCreateDocumentSkill(options:{docxEditable:boolean;createDocument:PdfDocumentCreator}):AgentSkill{
 return {
  id:'pdf-create-document',
  systemPrompt:'Use create_document only when asked to create a new separate document from this PDF. It creates a saved workspace file; it does not modify the source PDF. Only offered types are supported. Claim success only after the tool returns a saved file ID and revision. If creation is unconfirmed, ask the user to check existing workspace files and do not create it again.',
  tools:[{name:'create_document',description:'Create a new separate saved PDF (default), or DOCX when offered, containing the supplied restricted HTML. Returns the confirmed file ID and saved revision; opening a tab alone is not success.',inputSchema:{type:'object',additionalProperties:false,properties:{type:{type:'string',enum:options.docxEditable?['pdf','docx']:['pdf']},title:{type:'string',minLength:1},content:{type:'string',minLength:1}},required:['title','content']}}],
  async executeTool(call,signal){
   const input=call.input,type=input.type??'pdf'
   if(call.name!=='create_document'||typeof type!=='string'||!['pdf',...(options.docxEditable?['docx']:[])].includes(type)||typeof input.title!=='string'||!input.title.trim()||typeof input.content!=='string'||!input.content.trim())return {output:'Invalid new-document request. Use a nonempty title and HTML content with an offered file type. Nothing was created.',summary:'Create document',isError:true,mutated:false}
   // Match the desktop PDF tool: model tool output is not document HTML.
   if(/<\/?tool_response>/i.test(input.content)||/"index"\s*:\s*\d+\s*,\s*"type"\s*:\s*"/.test(input.content))return {output:'The content contains tool output. Retry with the intended document HTML. Nothing was created.',summary:'Create document',isError:true,mutated:false}
   try{
    const receipt=await options.createDocument({type:type as 'pdf'|'docx',title:input.title.trim(),content:input.content},signal)
    if(!isRevisionRef(receipt)||receipt.size<1)throw Error('Missing saved revision')
    return {output:`Created ${type.toUpperCase()} document "${input.title.trim()}" in the workspace. Saved file ID: ${receipt.fileId}; saved revision: ${receipt.revision}.`,summary:'Create document',mutated:true}
   }catch{return {output:'Document creation is not confirmed. Check existing workspace files before trying again; do not repeat creation automatically.',summary:'Create document not confirmed',isError:true,mutated:false}}
  },
 }
}
