import {PDFDocument} from 'pdf-lib'
import {assertPdfEditStructure,hasUnsupportedPdfForm} from '../../shared/pdf-edit-structure.mjs'

export async function nativePdfEditRestriction(bytes:Uint8Array,encrypted:boolean,lang:'zh'|'en'){
 const message=(zh:string,en:string)=>lang==='zh'?zh:en
 const locked=()=>message('只读：加密 PDF 在 Web 中不可编辑','Read only: encrypted PDFs cannot be edited on the web')
 if(encrypted)return locked()
 try{
  const doc=await PDFDocument.load(bytes,{ignoreEncryption:true,updateMetadata:false})
  if(doc.isEncrypted)return locked()
  assertPdfEditStructure(doc,{allowAcroForm:true})
  if(hasUnsupportedPdfForm(doc))return message('只读：包含 XFA 表单或不受支持的表单结构','Read only: XFA or an unsupported form structure')
  return null
 }catch(error){
  const code=(error as {code?:string}|null)?.code
  if(code==='SIGNATURE_EDIT_REFUSED')return message('只读：包含签名结构（未验证签名）','Read only: signature structure detected (signature not verified)')
  if(code==='PDF_EDIT_LIMIT')return message('只读：超出 PDF 编辑上限','Read only: PDF exceeds the editing limits')
  return message('只读：无法确认此 PDF 的结构可安全编辑','Read only: this PDF could not be checked for edit support')
 }
}
