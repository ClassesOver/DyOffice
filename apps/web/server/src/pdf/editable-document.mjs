import {EncryptedPDFError,PDFDocument,PDFName} from 'pdf-lib'
import {assertPdfEditStructure} from '../../../shared/pdf-edit-structure.mjs'

function fail(code){throw Object.assign(new Error(code),{code})}

export async function openEditablePdf(bytes,{allowAcroForm=false}={}){
 if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))fail('MAGIC_MISMATCH')
 let doc
 try{doc=await PDFDocument.load(bytes,{updateMetadata:false})}
 catch(error){fail(error instanceof EncryptedPDFError||bytes.includes(Buffer.from('/Encrypt'))?'PASSWORD':'UNREADABLE')}
 if(doc.isEncrypted)fail('PASSWORD')
 assertPdfEditStructure(doc,{allowAcroForm})
 if(!allowAcroForm&&doc.catalog.has(PDFName.of('AcroForm')))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 return doc
}
