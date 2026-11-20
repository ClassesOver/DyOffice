import {PDFArray,PDFDict,PDFName} from 'pdf-lib'

/** Structural edit policy shared by the Web viewer and canonical PDF workers. */
export function assertPdfEditStructure(doc,{allowAcroForm=false}={}){
 const fail=code=>{throw Object.assign(Error(code),{code})}
 if(doc.getPageCount()<1||doc.getPageCount()>100)fail('PDF_EDIT_LIMIT')
 const pending=doc.context.enumerateIndirectObjects().map(([,object])=>object),visited=new Set()
 while(pending.length){
  const object=pending.pop();if(!object||visited.has(object))continue
  visited.add(object);if(visited.size>100000)fail('PDF_EDIT_LIMIT')
  if(object instanceof PDFDict){
   if(String(object.get(PDFName.of('Type')))==='/Sig'||(String(object.get(PDFName.of('FT')))==='/Sig'&&(!allowAcroForm||(object.has(PDFName.of('V'))&&String(object.lookup(PDFName.of('V')))!=='null')))||object.has(PDFName.of('ByteRange')))fail('SIGNATURE_EDIT_REFUSED')
   pending.push(...object.values())
  }else if(object instanceof PDFArray)pending.push(...object.asArray())
  else if(object.dict instanceof PDFDict)pending.push(object.dict)
 }
 if(doc.catalog.has(PDFName.of('Perms')))fail('SIGNATURE_EDIT_REFUSED')
}

export function hasUnsupportedPdfForm(doc){
 const form=doc.catalog.lookup(PDFName.of('AcroForm'))
 return form!==undefined&&(!(form instanceof PDFDict)||form.has(PDFName.of('XFA')))
}
