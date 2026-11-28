import {PDFDict,PDFName} from 'pdf-lib'
import {assertNoPdfSignatures} from '../../pdf/src/shared/pdf-signature-guard.ts'

export const MAX_PDF_EDIT_PAGES=100
export const MAX_PDF_DRAFT_BLANK_PAGES=20

/** Structural edit policy shared by the Web viewer and canonical PDF workers. */
export function assertPdfEditStructure(doc,{allowAcroForm=false}={}){
 const fail=code=>{throw Object.assign(Error(code),{code})}
 if(doc.getPageCount()<1||doc.getPageCount()>MAX_PDF_EDIT_PAGES)fail('PDF_EDIT_LIMIT')
 assertNoPdfSignatures(doc,{allowUnsignedFields:allowAcroForm,maxObjects:100000})
}

export function hasUnsupportedPdfForm(doc){
 const form=doc.catalog.lookup(PDFName.of('AcroForm'))
 return form!==undefined&&(!(form instanceof PDFDict)||form.has(PDFName.of('XFA')))
}
