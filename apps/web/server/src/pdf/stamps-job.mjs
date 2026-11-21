import {randomUUID} from 'node:crypto'
import {PDFName,PDFDict,PDFArray,PDFRef,PDFStream,PDFHexString,PDFNumber} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import {validatePdfStampOperation} from '../../../../../packages/web-contracts/src/pdf-stamp-ops.ts'
import {drawingNames} from './isolate-image-resources.mjs'
import {validateStampSourceState,readStampContent} from './stamp-state.mjs'
import {openEditablePdf} from './editable-document.mjs'
import {DEFAULT_WATERMARK,DEFAULT_HEADER_FOOTER} from '../../../../pdf/src/renderer/stamps.ts'
import {fillStampPlaceholders,stampBarLayout,fitWatermarkFontSize} from '../../../../pdf/src/renderer/stamp-layout.ts'
import {fail,check,hash,requireEnvelope} from './job-common.mjs'
const MAX_BYTES=64*1024*1024,META=PDFName.of('DyOfficeStamps'),name=PDFName.of
export const pdfStampsSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_STAMP','PDF_STAMP_NOT_FOUND','PDF_STAMP_INTEGRITY_FAILED','PDF_STAMP_FONT_UNAVAILABLE','PDF_STAMP_LAYOUT_REFUSED','PDF_STAMP_VERIFY_FAILED','OUTPUT_LIMIT'])
export function parsePdfStampsRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>65536)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(request,'stamps','operation')
 try{return validatePdfStampOperation(request.operation)}catch{fail('INVALID_PDF_STAMP')}
}
const canonicalObject=value=>value instanceof PDFDict?'<<'+value.entries().filter(([key])=>String(key)!=='/Length').sort(([a],[b])=>String(a).localeCompare(String(b))).map(([key,item])=>String(key)+' '+canonicalObject(item)).join(' ')+'>>':value instanceof PDFArray?'['+value.asArray().map(canonicalObject).join(' ')+']':value instanceof PDFNumber?String(Math.fround(value.asNumber())):String(value)
const streamHash=stream=>hash(Buffer.concat([Buffer.from(canonicalObject(stream.dict)),stream.getContents()]))
const refs=page=>{const content=page.node.get(name('Contents'));if(!content)return [];const resolved=page.doc.context.lookup(content);return resolved instanceof PDFArray?resolved.asArray():[content]}
const sameRef=(a,b)=>a instanceof PDFRef&&b instanceof PDFRef&&a.toString()===b.toString()
function inspect(doc){
 const pages=doc.getPages(),all=[],configs={Watermark:[],HeaderFooter:[]}
 try{
  for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
   const page=pages[pageIndex],raw=page.node.get(META),meta=raw?page.doc.context.lookup(raw):undefined,records={}
   if(page.node.has(META)&&(!(meta instanceof PDFDict)||meta.keys().some(key=>!['/Version','/Watermark','/HeaderFooter','/Guard'].includes(String(key)))||meta.get(name('Version'))?.asNumber?.()!==1))fail('PDF_STAMP_INTEGRITY_FAILED')
   for(const kind of ['Watermark','HeaderFooter']){
    const record=meta?.lookupMaybe(name(kind),PDFDict)
    if(!record){configs[kind].push(null);continue}
    if(record.keys().map(String).sort().join(',')!=='/Config,/Form,/FormHash,/PageIndex,/Resource,/Stream,/StreamHash')fail('PDF_STAMP_INTEGRITY_FAILED')
    const streamRef=record.get(name('Stream')),formRef=record.get(name('Form')),resource=record.get(name('Resource')),config=record.get(name('Config'))?.decodeText?.(),stream=doc.context.lookup(streamRef),form=doc.context.lookup(formRef)
    if(!(streamRef instanceof PDFRef)||!(formRef instanceof PDFRef)||!(resource instanceof PDFName)||!/^\/DyOfficeStamp_[a-f0-9]{32}$/.test(String(resource))||record.get(name('PageIndex'))?.asNumber?.()!==pageIndex||!(stream instanceof PDFStream)||!(form instanceof PDFStream)||String(form.dict.get(name('Subtype')))!=='/Form'||streamHash(stream)!==record.get(name('StreamHash'))?.decodeText?.()||streamHash(form)!==record.get(name('FormHash'))?.decodeText?.())fail('PDF_STAMP_INTEGRITY_FAILED')
    if(Buffer.from(stream.getContents()).toString()!==`%DyOffice.ManagedStamp.v1 ${kind}\nq\n${resource} Do\nQ\n`||refs(page).filter(ref=>sameRef(ref,streamRef)).length!==1||!sameRef(page.node.Resources()?.lookupMaybe(name('XObject'),PDFDict)?.get(resource),formRef))fail('PDF_STAMP_INTEGRITY_FAILED')
    let value;try{value=JSON.parse(config);const validated=validatePdfStampOperation(value);if(JSON.stringify(validated)!==config||value.op!==(kind==='Watermark'?'set_watermark':'set_header_footer'))fail('PDF_STAMP_INTEGRITY_FAILED')}catch{fail('PDF_STAMP_INTEGRITY_FAILED')}
    configs[kind].push(config);records[kind]={record,streamRef,formRef,resource,config:value}
   }
   if(meta){
    const guard=meta.lookupMaybe(name('Guard'),PDFDict),contents=refs(page)
    if(!guard||guard.keys().map(String).sort().join(',')!=='/Begin,/End')fail('PDF_STAMP_INTEGRITY_FAILED')
    const begin=guard.get(name('Begin')),end=guard.get(name('End')),owned=Object.values(records)
    for(const [ref,expected] of [[begin,'%DyOffice.ManagedStamp.State.v1\nq\n'],[end,'\nQ\n%DyOffice.ManagedStamp.State.v1\n']]){
     const stream=doc.context.lookup(ref)
     if(!(ref instanceof PDFRef)||!(stream instanceof PDFStream)||stream.dict.keys().some(key=>String(key)!=='/Length')||Buffer.from(stream.getContents()).toString()!==expected||contents.filter(item=>sameRef(item,ref)).length!==1)fail('PDF_STAMP_INTEGRITY_FAILED')
    }
    const beginIndex=contents.findIndex(ref=>sameRef(ref,begin)),endIndex=contents.findIndex(ref=>sameRef(ref,end))
    if(!owned.length||beginIndex<0||endIndex<=beginIndex||beginIndex>=contents.length-endIndex)fail('PDF_STAMP_INTEGRITY_FAILED')
    // pdf-lib normalizes the page when it adds a form widget or annotation.
    for(let i=0;i<beginIndex;i++){
     if(readStampContent(doc,[contents[i]]).trim()!=='q'||readStampContent(doc,[contents.at(-1-i)]).trim()!=='Q')fail('PDF_STAMP_INTEGRITY_FAILED')
    }
    Object.defineProperty(records,'guard',{value:{begin,end}})
   }
   all.push(records)
  }
  for(const kind of ['Watermark','HeaderFooter'])if(new Set(configs[kind]).size>1)fail('PDF_STAMP_INTEGRITY_FAILED')
  const owned=all.flatMap(records=>Object.values(records).map(record=>record.streamRef.toString()))
  if(new Set(owned).size!==owned.length)fail('PDF_STAMP_INTEGRITY_FAILED')
  return all
 }catch(error){if(error?.code)throw error;fail('PDF_STAMP_INTEGRITY_FAILED')}
}
function sourceFingerprint(doc,managed){
 return doc.getPages().map((page,index)=>{
  const owned=Object.values(managed[index]),content=refs(page).filter(ref=>!owned.some(record=>sameRef(record.streamRef,ref))&&!Object.values(managed[index].guard??{}).some(guard=>sameRef(guard,ref))).map(ref=>{const stream=doc.context.lookup(ref);if(!(stream instanceof PDFStream))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE');return [String(ref),streamHash(stream)]})
  const resources=page.node.Resources()?.clone(doc.context),xo=resources?.lookupMaybe(name('XObject'),PDFDict)?.clone(doc.context)
  if(xo){for(const record of owned)xo.delete(record.resource);if(xo.keys().length)resources.set(name('XObject'),xo);else resources.delete(name('XObject'))}
  return JSON.stringify({content,resources:String(resources),attributes:page.node.entries().filter(([key])=>!['/Contents','/Resources','/DyOfficeStamps'].includes(String(key))).map(([key,value])=>[String(key),String(value)])})
 })
}
function geometry(page){
 const media=page.getMediaBox(),crop=page.getCropBox(),x0=Math.max(media.x,crop.x),y0=Math.max(media.y,crop.y),x1=Math.min(media.x+media.width,crop.x+crop.width),y1=Math.min(media.y+media.height,crop.y+crop.height),unit=page.node.lookup(name('UserUnit'))?.asNumber?.()??1,rotation=((page.getRotation().angle%360)+360)%360
 if(![x0,y0,x1,y1,unit].every(Number.isFinite)||x1<=x0||y1<=y0||unit<=0||unit>75000||![0,90,180,270].includes(rotation))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 if((x1-x0)*unit>20000||(y1-y0)*unit>20000)fail('PDF_STAMP_LAYOUT_REFUSED')
 return {x0,y0,x1,y1,unit,pw:(x1-x0)*unit,ph:(y1-y0)*unit}
}
function configuration(operation,previous){
 if(operation.op==='set_watermark')return {op:operation.op,text:operation.text,angle:operation.angle??previous?.angle??DEFAULT_WATERMARK.angle,opacity:operation.opacity??previous?.opacity??DEFAULT_WATERMARK.opacity,color:operation.color??previous?.color??DEFAULT_WATERMARK.color,size:operation.size??previous?.size??DEFAULT_WATERMARK.sizeRatio}
 return {op:operation.op,header_left:operation.header_left??'',header_center:operation.header_center??'',header_right:operation.header_right??'',footer_left:operation.footer_left??'',footer_center:operation.footer_center??'',footer_right:operation.footer_right??'',page_number:operation.page_number??false,start_at:operation.start_at??DEFAULT_HEADER_FOOTER.startAt,font_size:operation.font_size??DEFAULT_HEADER_FOOTER.fontSize,color:operation.color??DEFAULT_HEADER_FOOTER.color}
}
const empty=config=>config.op==='set_watermark'?!config.text:!config.page_number&&['header_left','header_center','header_right','footer_left','footer_center','footer_right'].every(key=>!config[key])
const rgb=config=>config.color.replace(/^#/,'').match(/../g).map(hex=>parseInt(hex,16)/255)
function pageTexts(config,index,total){
 if(config.op==='set_watermark')return [config.text]
 const no=config.start_at+index,fill=text=>fillStampPlaceholders(text,no,total)
 return [fill(config.header_left),fill(config.header_center),fill(config.header_right),fill(config.footer_left),config.page_number?`${no} / ${total}`:fill(config.footer_center),fill(config.footer_right)]
}
async function fontFor(doc,text,bold){
 const {resolveTextInsertFont}=await import('../../../../pdf/src/main/text-edit.ts')
 try{
  const resolved=await resolveTextInsertFont({text,bold}),face=fontkit.create(resolved.bytes)
  for(const char of text)if(!/\s/.test(char)&&face.glyphForCodePoint(char.codePointAt(0)).id===0)fail('PDF_STAMP_FONT_UNAVAILABLE')
  doc.registerFontkit(fontkit);const embedded=await doc.embedFont(resolved.bytes,{subset:true});return {face,embedded,syntheticBold:bold&&resolved.syntheticBold}
 }catch(error){if(error?.code)throw error;fail('PDF_STAMP_FONT_UNAVAILABLE')}
}
function drawCommands(config,texts,g,font){
 const commands=[],{pw,ph,unit,x0,y0}=g,[r,green,b]=rgb(config),metric=(font.face.ascent+font.face.descent)/2/font.face.unitsPerEm
 const measure=(text,size)=>font.embedded.widthOfTextAtSize(text,size)
 const write=(text,size,x,y,angle=0)=>{
  const theta=angle*Math.PI/180,c=Math.cos(theta),s=Math.sin(theta),offset=metric*size
  commands.push('BT',`/StampFont ${size} Tf`,`${r} ${green} ${b} rg`)
  if(font.syntheticBold)commands.push(`${r} ${green} ${b} RG`,`${size*.02} w`,'2 Tr')
  commands.push(`${c} ${s} ${-s} ${c} ${x+s*offset} ${y-c*offset} Tm`,`${font.embedded.encodeText(text)} Tj`,'ET')
 }
 if(config.op==='set_watermark'){
  const base=pw*config.size,size=fitWatermarkFontSize(pw,ph,config.size,measure(config.text,base)),width=measure(config.text,size),height=(font.face.ascent-font.face.descent)/font.face.unitsPerEm*size,angle=config.angle*Math.PI/180
  if(size<4||Math.abs(Math.cos(angle))*width+Math.abs(Math.sin(angle))*height>pw+.01||Math.abs(Math.sin(angle))*width+Math.abs(Math.cos(angle))*height>ph+.01)fail('PDF_STAMP_LAYOUT_REFUSED')
  const cx=pw/2-Math.cos(angle)*width/2,cy=ph/2-Math.sin(angle)*width/2;write(config.text,size,cx,cy,config.angle)
 }else{
  const {height,margin,padding}=stampBarLayout(pw,ph,config.font_size)
  if(height+margin>ph/2||(font.face.ascent-font.face.descent)/font.face.unitsPerEm*config.font_size>height)fail('PDF_STAMP_LAYOUT_REFUSED')
  for(let row=0;row<2;row++){
   let previousRight=-Infinity
   for(let column=0;column<3;column++){
    const text=texts[row*3+column];if(!text)continue
    const width=measure(text,config.font_size),left=column===0?padding:column===1?(pw-width)/2:pw-padding-width
    if(left<0||left+width>pw||left<previousRight+1)fail('PDF_STAMP_LAYOUT_REFUSED')
    previousRight=left+width;write(text,config.font_size,left,row===0?ph-margin-height/2:margin+height/2)
   }
  }
 }
 return `q\n/StampState gs\n${1/unit} 0 0 ${1/unit} ${x0} ${y0} cm\n${commands.join('\n')}\nQ\n`
}
export function createPdfStampsJob({allowAcroForm=false}={}){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY');if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operation=parsePdfStampsRequest(raw),original=Buffer.from(input);busy=true
  try{
   const doc=await openEditablePdf(original,{allowAcroForm}),managed=inspect(doc),before=sourceFingerprint(doc,managed),kind=operation.op==='set_watermark'?'Watermark':'HeaderFooter',config=configuration(operation,managed[0][kind]?.config),removing=empty(config),pages=doc.getPages(),geometries=pages.map(geometry)
   for(let index=0;index<pages.length;index++)validateStampSourceState(doc,refs(pages[index]).filter(ref=>!Object.values(managed[index]).some(record=>sameRef(record.streamRef,ref))&&!Object.values(managed[index].guard??{}).some(guard=>sameRef(guard,ref))))
   if(removing&&!managed[0][kind])fail('PDF_STAMP_NOT_FOUND')
   let font,plans=[]
   if(!removing){const texts=pages.map((_,index)=>pageTexts(config,index,pages.length));font=await fontFor(doc,texts.flat().join(''),kind==='Watermark');plans=texts.map((parts,index)=>drawCommands(config,parts,geometries[index],font));await font.embedded.embed()}
   check(signal)
   // All records and all layouts pass before changing any page content/resource.
   for(let index=0;index<pages.length;index++){
    const page=pages[index],old=managed[index][kind],content=refs(page).filter(ref=>(!old||!sameRef(ref,old.streamRef))&&!Object.values(managed[index].guard??{}).some(guard=>sameRef(guard,ref))),meta=page.node.lookupMaybe(META,PDFDict)?.clone(doc.context)??doc.context.obj({Version:1})
    if(old){
     meta.delete(name(kind))
     const resources=page.node.Resources()?.clone(doc.context),xo=resources?.lookupMaybe(name('XObject'),PDFDict)?.clone(doc.context)
     if(xo){xo.delete(old.resource);resources.set(name('XObject'),xo);page.node.set(name('Resources'),resources)}
    }
    if(!removing){
     const resource=name(`DyOfficeStamp_${randomUUID().replaceAll('-','')}`),g=geometries[index],form=doc.context.flateStream(plans[index],{Type:'XObject',Subtype:'Form',BBox:[g.x0,g.y0,g.x1,g.y1],Resources:{Font:{StampFont:font.embedded.ref},ExtGState:{StampState:{Type:'ExtGState',ca:kind==='Watermark'?config.opacity:1,CA:kind==='Watermark'?config.opacity:1,BM:'Normal'}}}}),formRef=doc.context.register(form)
     const stream=doc.context.stream(`%DyOffice.ManagedStamp.v1 ${kind}\nq\n${resource} Do\nQ\n`),streamRef=doc.context.register(stream),resources=page.node.Resources()?.clone(doc.context)??doc.context.obj({}),xo=resources.lookupMaybe(name('XObject'),PDFDict)?.clone(doc.context)??doc.context.obj({})
     xo.set(resource,formRef);resources.set(name('XObject'),xo);page.node.set(name('Resources'),resources);content.push(streamRef)
     const canonical=JSON.stringify(validatePdfStampOperation(config))
     meta.set(name(kind),doc.context.obj({PageIndex:index,Resource:resource,Stream:streamRef,Form:formRef,Config:PDFHexString.fromText(canonical),StreamHash:PDFHexString.fromText(streamHash(stream)),FormHash:PDFHexString.fromText(streamHash(form))}))
    }
    if(meta.has(name('Watermark'))||meta.has(name('HeaderFooter'))){
     const guard=managed[index].guard??{begin:doc.context.register(doc.context.stream('%DyOffice.ManagedStamp.State.v1\nq\n')),end:doc.context.register(doc.context.stream('\nQ\n%DyOffice.ManagedStamp.State.v1\n'))},owned=['Watermark','HeaderFooter'].map(type=>meta.lookupMaybe(name(type),PDFDict)?.get(name('Stream'))).filter(Boolean),source=content.filter(ref=>!owned.some(item=>sameRef(item,ref))),overlays=content.filter(ref=>owned.some(item=>sameRef(item,ref)))
     content.splice(0,content.length,guard.begin,...source,guard.end,...overlays);meta.set(name('Guard'),doc.context.obj({Begin:guard.begin,End:guard.end}))
    }else meta.delete(name('Guard'))
    page.node.set(name('Contents'),doc.context.obj(content));if(meta.has(name('Watermark'))||meta.has(name('HeaderFooter')))page.node.set(META,meta);else page.node.delete(META)
   }
   const bytes=Buffer.from(await doc.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false}));check(signal)
   if(bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   const reopened=await openEditablePdf(bytes,{allowAcroForm}),saved=inspect(reopened)
   if(JSON.stringify(sourceFingerprint(reopened,saved))!==JSON.stringify(before))fail('PDF_STAMP_VERIFY_FAILED')
   for(const records of saved)if(removing?records[kind]!==undefined:JSON.stringify(records[kind]?.config)!==JSON.stringify(validatePdfStampOperation(config)))fail('PDF_STAMP_VERIFY_FAILED')
   return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfStampsSafetyCodes.has(error?.code))throw error;fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}

/** Validate and detach managed overlays before page topology changes. */
export async function capturePdfManagedStamps(input,{allowAcroForm=false}={}){
 const doc=await openEditablePdf(input,{allowAcroForm}),managed=inspect(doc),operations=Object.values(managed[0]??{}).map(record=>record.config)
 if(!operations.length)return {bytes:Buffer.from(input),operations}
 for(let index=0;index<doc.getPageCount();index++){
  const page=doc.getPage(index),records=managed[index],owned=Object.values(records),resources=page.node.Resources()?.clone(doc.context),xo=resources?.lookupMaybe(name('XObject'),PDFDict)?.clone(doc.context)
  if(xo){for(const record of owned)xo.delete(record.resource);resources.set(name('XObject'),xo);page.node.set(name('Resources'),resources)}
  page.node.set(name('Contents'),doc.context.obj(refs(page).filter(ref=>!owned.some(record=>sameRef(record.streamRef,ref))&&!Object.values(records.guard??{}).some(guard=>sameRef(guard,ref)))));page.node.delete(META)
 }
 return {bytes:Buffer.from(await doc.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false})),operations}
}
export async function reapplyPdfManagedStamps(input,operations,{allowAcroForm=false,signal}={}){
 let bytes=Buffer.from(input)
 for(const operation of operations)bytes=(await createPdfStampsJob({allowAcroForm}).execute(bytes,JSON.stringify({version:1,action:'stamps',operation}),signal)).bytes
 return bytes
}
export function assertPdfManagedStamps(doc){inspect(doc)}

/** PDFium regenerates page content and renames XObjects. Recover each verified
 * managed Form invocation at its existing painting position after native edits;
 * the native object indices have already been consumed and are never shifted. */
export async function preservePdfManagedStamps(input,output,{allowAcroForm=false,pending=false}={}){
 const original=await openEditablePdf(Buffer.from(input),{allowAcroForm}),managed=inspect(original)
 if(!pending&&allowAcroForm&&original.catalog.has(name('AcroForm'))&&managed.some(records=>Object.keys(records).length))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 if(!managed.some(records=>Object.keys(records).length))return Buffer.from(output)
 const doc=await openEditablePdf(Buffer.from(output),{allowAcroForm})
 if(doc.getPageCount()!==original.getPageCount())fail('PDF_STAMP_INTEGRITY_FAILED')
 try{
  const current=inspect(doc)
  if(managed.every((records,i)=>Object.keys(records).length===Object.keys(current[i]).length&&Object.entries(records).every(([kind,old])=>{
   const next=current[i][kind]
   return next&&JSON.stringify(old.config)===JSON.stringify(next.config)&&streamHash(original.context.lookup(old.formRef))===streamHash(doc.context.lookup(next.formRef))
  })))return Buffer.from(output)
 }catch{}
 for(let index=0;index<doc.getPageCount();index++){
  const page=doc.getPage(index),records=managed[index],meta=page.node.lookupMaybe(META,PDFDict),source=readStampContent(doc,refs(page)),draws=drawingNames(source),resources=page.node.Resources()?.clone(doc.context),xo=resources?.lookupMaybe(name('XObject'),PDFDict)?.clone(doc.context),replacements=[]
  if(!meta||!xo)fail('PDF_STAMP_INTEGRITY_FAILED')
  for(const [kind,previous]of Object.entries(records)){
   const record=meta.lookupMaybe(name(kind),PDFDict),formRef=record?.get(name('Form')),form=doc.context.lookup(formRef)
   if(!record||record.get(name('Config'))?.decodeText?.()!==JSON.stringify(previous.config)||!(formRef instanceof PDFRef)||!(form instanceof PDFStream)||streamHash(form)!==streamHash(original.context.lookup(previous.formRef)))fail('PDF_STAMP_INTEGRITY_FAILED')
   const aliases=xo.entries().filter(([,ref])=>sameRef(ref,formRef)).map(([key])=>key.decodeText()),occurrences=draws.filter(draw=>aliases.includes(draw.value))
   if(occurrences.length!==1||occurrences[0].markedContent)fail('PDF_STAMP_INTEGRITY_FAILED')
   const resource=previous.resource,stream=doc.context.stream(`%DyOffice.ManagedStamp.v1 ${kind}\nq\n${resource} Do\nQ\n`),streamRef=doc.context.register(stream)
   replacements.push({...occurrences[0],streamRef})
   for(const alias of aliases)xo.delete(name(alias))
   xo.set(resource,formRef)
   record.set(name('PageIndex'),doc.context.obj(index));record.set(name('Resource'),resource);record.set(name('Stream'),streamRef);record.set(name('StreamHash'),PDFHexString.fromText(streamHash(stream)));record.set(name('FormHash'),PDFHexString.fromText(streamHash(form)))
  }
  // A Do's resource-name token ends before the Do operator. Replace both tokens,
  // retaining all surrounding q/Q, CTM, clipping and painting instructions.
  const content=[],begin=doc.context.register(doc.context.stream('%DyOffice.ManagedStamp.State.v1\nq\n')),end=doc.context.register(doc.context.stream('\nQ\n%DyOffice.ManagedStamp.State.v1\n'))
  let cursor=0
  for(const item of replacements.sort((a,b)=>a.start-b.start)){
   const match=/^\s*Do(?:[\x00\t\n\f\r ]|$)/.exec(source.slice(item.end));if(!match)fail('PDF_STAMP_INTEGRITY_FAILED')
   content.push(doc.context.register(doc.context.flateStream(source.slice(cursor,item.start))),item.streamRef);cursor=item.end+match[0].length
  }
  content.push(doc.context.register(doc.context.flateStream(source.slice(cursor))))
  resources.set(name('XObject'),xo);page.node.set(name('Resources'),resources);page.node.set(name('Contents'),doc.context.obj([begin,...content,end]));meta.set(name('Guard'),doc.context.obj({Begin:begin,End:end}))
 }
 const bytes=Buffer.from(await doc.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false}));inspect(await openEditablePdf(bytes,{allowAcroForm}));return bytes
}
