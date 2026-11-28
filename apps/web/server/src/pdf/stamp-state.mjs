import {inflateSync} from 'node:zlib'
import {PDFArray,PDFName,PDFStream} from '../../../../pdf/src/shared/pdf-lib.ts'
const fail=()=>{throw Object.assign(Error('PDF_EDIT_UNSUPPORTED_STRUCTURE'),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})}
const white=c=>/[\x00\t\n\f\r ]/.test(c),delimiter=c=>c===undefined||white(c)||'()<>[]{}/%'.includes(c)
// Appended overlays need the initial page graphics state. Reject ambiguous or
// unbalanced source syntax before adding the managed q/Q isolation streams.
export function readStampContent(doc,streams){
 let budget=32*1024*1024
 return streams.map(ref=>{
  const stream=doc.context.lookup(ref);if(!(stream instanceof PDFStream))fail()
  const filter=stream.dict.get(PDFName.of('Filter')),filters=filter instanceof PDFArray?filter.asArray().map(String):filter?[String(filter)]:[]
  if(stream.dict.has(PDFName.of('DecodeParms'))||filters.length>1||filters.some(value=>!['/FlateDecode','/Fl'].includes(value)))fail()
  const limit=Math.min(budget,8*1024*1024);if(limit<1)fail()
  const bytes=filters.length?inflateSync(stream.getContents(),{maxOutputLength:limit}):stream.getContents();if(bytes.length>limit)fail();budget-=bytes.length
  return Buffer.from(bytes).toString('latin1')
 }).join(' ')
}
export function validateStampSourceState(doc,streams){
 const source=readStampContent(doc,streams)
 let index=0,depth=0,graphics=0,text=false,marked=0,compat=0
 while(index<source.length){
  const char=source[index]
  if(white(char)){index++;continue}
  if(char==='%'){while(index<source.length&&!['\n','\r'].includes(source[index]))index++;continue}
  if(char==='('){let nesting=1;index++;while(index<source.length&&nesting){const c=source[index++];if(c==='\\')index++;else if(c==='(')nesting++;else if(c===')')nesting--}if(nesting)fail();continue}
  if(char==='<'){if(source[index+1]==='<'){depth++;index+=2}else{index++;while(index<source.length&&source[index]!=='>')index++;if(index===source.length)fail();index++}continue}
  if(char==='>'&&source[index+1]==='>'){if(--depth<0)fail();index+=2;continue}
  if(char==='['){depth++;index++;continue}
  if(char===']'){if(--depth<0)fail();index++;continue}
  if(')>{}'.includes(char))fail()
  if(char==='/'){index++;while(index<source.length&&!delimiter(source[index]))index++;continue}
  const start=index;while(index<source.length&&!delimiter(source[index]))index++;if(start===index)fail()
  if(depth)continue
  const op=source.slice(start,index)
  if(op==='BI')fail()
  if(op==='q')graphics++
  if(op==='Q'&&--graphics<0)fail()
  if(op==='BT'){if(text)fail();text=true}
  if(op==='ET'){if(!text)fail();text=false}
  if(op==='BMC'||op==='BDC')marked++
  if(op==='EMC'&&--marked<0)fail()
  if(op==='BX')compat++
  if(op==='EX'&&--compat<0)fail()
 }
 if(depth||graphics||text||marked||compat)fail()
}
