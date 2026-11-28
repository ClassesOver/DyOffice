import {PDFDocument} from '../../../pdf/src/shared/pdf-lib.ts'
import {staticFormFillsFromCatalog} from '../../../pdf/src/shared/static-form-fills'
import {assertPdfEditStructure,hasUnsupportedPdfForm} from '../../shared/pdf-edit-structure.mjs'

export async function inspectNativePdf(bytes:Uint8Array,encrypted:boolean,lang:'zh'|'en'){
 const message=(zh:string,en:string)=>lang==='zh'?zh:en
 const restricted=(restriction:string)=>({restriction,staticFormFills:[]})
 const locked=()=>message('只读：加密 PDF 在 Web 中不可编辑','Read only: encrypted PDFs cannot be edited on the web')
 if(encrypted)return restricted(locked())
 try{
  const doc=await PDFDocument.load(bytes,{ignoreEncryption:true,updateMetadata:false})
  if(doc.isEncrypted)return restricted(locked())
  assertPdfEditStructure(doc,{allowAcroForm:true})
  if(hasUnsupportedPdfForm(doc))return restricted(message('只读：包含 XFA 表单或不受支持的表单结构','Read only: XFA or an unsupported form structure'))
  return {restriction:null,staticFormFills:staticFormFillsFromCatalog(doc)}
 }catch(error){
  const code=(error as {code?:string}|null)?.code
  if(code==='SIGNATURE_EDIT_REFUSED')return restricted(message('只读：包含签名结构','Read only: signature structure detected'))
  if(code==='PDF_EDIT_LIMIT')return restricted(message('只读：超出 PDF 编辑上限','Read only: PDF exceeds the editing limits'))
  return restricted(message('只读：无法确认此 PDF 的结构可安全编辑','Read only: this PDF could not be checked for edit support'))
 }
}
