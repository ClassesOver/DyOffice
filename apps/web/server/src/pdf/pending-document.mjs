import {PDFName,PDFDict,PDFArray} from 'pdf-lib'
import {hasUnsupportedPdfForm} from '../../../shared/pdf-edit-structure.mjs'
import {openEditablePdf} from './editable-document.mjs'
import {assertPdfManagedStamps} from './stamps-job.mjs'
import {fail} from './job-common.mjs'
const n=PDFName.of

/** Shared protection boundary for canonical edits and their read-only planning. */
export async function openPdfForPendingEdits(bytes){
 const doc=await openEditablePdf(bytes,{allowAcroForm:true})
 if(hasUnsupportedPdfForm(doc))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 const pending=doc.context.enumerateIndirectObjects().map(([,v])=>v),seen=new Set()
 while(pending.length){const v=pending.pop();if(!v||seen.has(v))continue;seen.add(v);if(seen.size>100000)fail('PDF_EDIT_LIMIT')
  if(v instanceof PDFDict){if(String(v.lookup(n('Type')))==='/Sig'||v.has(n('ByteRange'))||String(v.lookup(n('FT')))==='/Sig'&&v.has(n('V'))&&String(v.lookup(n('V')))!=='null')fail('SIGNATURE_EDIT_REFUSED');pending.push(...v.values())}
  else if(v instanceof PDFArray)pending.push(...v.asArray());else if(v.dict instanceof PDFDict)pending.push(v.dict)
 }
 if(doc.getPages().some(p=>p.node.has(n('DyOfficeStamps'))))assertPdfManagedStamps(doc)
 return doc
}
