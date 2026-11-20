import {PNG} from 'pngjs'
import {inflateSync,deflateSync} from 'node:zlib'
import {PDFDocument,PDFDict,PDFArray,PDFStream,PDFName,PDFRawStream} from 'pdf-lib'

const name=PDFName.of,MAX_BYTES=64*1024*1024
const namedResource=(resources,decoded)=>resources?.entries().find(([key])=>key.decodeText()===decoded)?.[1]
function fail(){throw Object.assign(Error('PDF_IMAGE_RESOURCE_UNSUPPORTED'),{code:'PDF_IMAGE_RESOURCE_UNSUPPORTED'})}
const white=char=>/[\x00\t\n\f\r ]/.test(char)
const delimiter=char=>char===undefined||white(char)||'()<>[]{}/%'.includes(char)
/** Token offsets are retained so only real resource-name operands are rewritten. */
export function drawingNames(source){
 const draws=[];let index=0,previous,nesting=0,markedDepth=0
 while(index<source.length){
  const start=index,char=source[index]
  if(white(char)){index++;continue}
  if(char==='%'){while(index<source.length&&!['\n','\r'].includes(source[index]))index++;continue}
  if(char==='('){let depth=1;index++;while(index<source.length&&depth){const c=source[index++];if(c==='\\'){if(index<source.length)index++}else if(c==='(')depth++;else if(c===')')depth--}if(depth)fail();previous=undefined;continue}
  if(char==='<'){
   if(source[index+1]==='<'){nesting++;index+=2}else{index++;while(index<source.length&&source[index]!=='>')index++;if(index===source.length)fail();index++}
   previous=undefined;continue
  }
  if(char==='>'&&source[index+1]==='>'){if(--nesting<0)fail();index+=2;previous=undefined;continue}
  if(char==='['){nesting++;index++;previous=undefined;continue}
  if(char===']'){if(--nesting<0)fail();index++;previous=undefined;continue}
  if(')>{}'.includes(char))fail()
  if(char==='/'){
   index++;while(index<source.length&&!delimiter(source[index]))index++
   const raw=source.slice(start+1,index)
   if(/#(?![0-9a-fA-F]{2})/.test(raw))fail()
   previous={start,end:index,value:raw.replace(/#([0-9a-fA-F]{2})/g,(_,hex)=>String.fromCharCode(parseInt(hex,16)))};continue
  }
  while(index<source.length&&!delimiter(source[index]))index++
  if(index===start)fail()
  const op=source.slice(start,index)
  if(nesting===0&&op==='BI')fail() // Inline image data has no unambiguous token terminator.
  if(nesting===0&&['BMC','BDC'].includes(op))markedDepth++
  if(nesting===0&&op==='EMC'){if(--markedDepth<0)fail()}
  if(nesting===0&&op==='Do'){if(!previous)fail();draws.push({...previous,markedContent:markedDepth>0})}
  previous=undefined
 }
 if(nesting!==0)fail()
 return draws
}

/** Clone image/Form resources at each actual Do occurrence, keeping all other
 * content bytes, graphics state, resource entries and painting order intact.
 * SetBitmap may then mutate one occurrence without changing shared CPDF_Image. */
export async function isolatePdfImageResources(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_BYTES)fail()
 const doc=await PDFDocument.load(bytes,{updateMetadata:false}),context=doc.context
 let remaining=32*1024*1024,count=0
 const decode=stream=>{
  if(!(stream instanceof PDFStream))fail()
  const raw=stream.getContents(),filter=stream.dict.get(name('Filter'))
  const filters=filter instanceof PDFArray?filter.asArray().map(String):filter?[String(filter)]:[]
  if(stream.dict.has(name('DecodeParms'))||filters.length>1||filters.some(value=>!['/FlateDecode','/Fl'].includes(value)))fail()
  const limit=Math.min(8*1024*1024,remaining)
  if(limit<0)fail()
  const decoded=filters.length?inflateSync(raw,{maxOutputLength:Math.max(1,limit)}):raw
  if(decoded.length>limit)fail();remaining-=decoded.length
  return Buffer.from(decoded).toString('latin1')
 }
 const rewrite=(contents,resources,ancestors=new Set())=>{
  if(!(resources instanceof PDFDict))fail()
  const cloned=resources.clone(context),originalX=resources.lookupMaybe(name('XObject'),PDFDict),xobjects=originalX?.clone(context)??context.obj({})
  cloned.set(name('XObject'),xobjects)
  const parts=contents instanceof PDFArray?contents.asArray():contents?[contents]:[]
  // Match PDFium content-array boundaries: a space separates tokens without
  // terminating a comment that continues into the next stream.
  const source=parts.map(ref=>decode(context.lookup(ref))).join(' '),replacements=[]
  for(const token of drawingNames(source)){
   if(++count>10000||ancestors.size>16)fail()
   const object=context.lookup(namedResource(originalX,token.value))
   if(!(object instanceof PDFStream))fail()
   const subtype=String(object.dict.get(name('Subtype')))
   if(!['/Image','/Form'].includes(subtype))fail()
   let ref
   if(subtype==='/Image'){
    const dict=object.dict.clone(context)
    ref=context.register(PDFRawStream.of(dict,Uint8Array.from(object.getContents())))
   }else{
    if(ancestors.has(object))fail()
    const formResources=object.dict.lookupMaybe(name('Resources'),PDFDict)??resources
    const nested=rewrite(object,formResources,new Set(ancestors).add(object)),dict=object.dict.clone(context)
    dict.delete(name('Filter'));dict.delete(name('DecodeParms'));dict.set(name('Resources'),nested.resources)
    dict.set(name('Filter'),name('FlateDecode'))
    ref=context.register(PDFRawStream.of(dict,deflateSync(Buffer.from(nested.source,'latin1'))))
   }
   let unique='DyOfficeImage'+count
   while(xobjects.has(name(unique)))unique+='x'
   xobjects.set(name(unique),ref)
   replacements.push({...token,replacement:name(unique).toString()})
  }
  let result=source
  for(const replacement of replacements.reverse())result=result.slice(0,replacement.start)+replacement.replacement+result.slice(replacement.end)
  return {source:result,resources:cloned}
 }
 try{
  if(doc.getPageCount()<1||doc.getPageCount()>100)fail()
  for(const page of doc.getPages()){
   const rewritten=rewrite(page.node.Contents(),page.node.Resources()??context.obj({}))
   page.node.set(name('Resources'),rewritten.resources)
   page.node.set(name('Contents'),context.register(context.flateStream(Buffer.from(rewritten.source,'latin1'))))
  }
  const result=Buffer.from(await doc.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false}))
  if(result.length>MAX_BYTES)fail()
  return result
 }catch(error){if(error?.code==='PDF_IMAGE_RESOURCE_UNSUPPORTED')throw error;fail()}
}

/** One intrinsic image on a bare page: retain the image's own SMask but omit
 * occurrence graphics state (clip, alpha and blend). Ordinal follows native
 * depth-first image painting order within the requested page. */
async function locateImage(bytes,pageIndex,imageOrdinal){
 if(!Buffer.isBuffer(bytes)||bytes.length>MAX_BYTES||!Number.isSafeInteger(pageIndex)||pageIndex<0||!Number.isSafeInteger(imageOrdinal)||imageOrdinal<0)fail()
 const doc=await PDFDocument.load(bytes,{updateMetadata:false}),context=doc.context,page=doc.getPages()[pageIndex]
 if(!page)fail()
 let ordinal=0,target,count=0,remaining=32*1024*1024
 const walk=(contents,resources,ancestors=new Set(),inheritedUnsafe=false)=>{
  if(!(resources instanceof PDFDict)||ancestors.size>16)fail()
  const parts=contents instanceof PDFArray?contents.asArray():contents?[contents]:[],xobjects=resources.lookupMaybe(name('XObject'),PDFDict)
  const graphics=resources.lookupMaybe(name('ExtGState'),PDFDict)
  const unsafe=inheritedUnsafe||!!graphics?.entries().some(([,ref])=>{
   const state=context.lookup(ref);if(!(state instanceof PDFDict))return true
   const blend=state.lookup(name('BM')),values=blend instanceof PDFArray?blend.asArray().map(String):blend?[String(blend)]:[]
   return values.some(value=>!['/Normal','/Compatible'].includes(value))
  })
  const source=parts.map(ref=>{
   const stream=context.lookup(ref);if(!(stream instanceof PDFStream))fail()
   const filter=stream.dict.get(name('Filter')),filters=filter instanceof PDFArray?filter.asArray().map(String):filter?[String(filter)]:[]
   if(stream.dict.has(name('DecodeParms'))||filters.length>1||filters.some(v=>!['/FlateDecode','/Fl'].includes(v)))fail()
   const limit=Math.min(8*1024*1024,remaining),raw=stream.getContents()
   const data=filters.length?inflateSync(raw,{maxOutputLength:Math.max(1,limit)}):raw
   if(data.length>limit)fail();remaining-=data.length;return Buffer.from(data).toString('latin1')
  }).join(' ')
  for(const token of drawingNames(source)){
   if(++count>10000)fail()
   const ref=namedResource(xobjects,token.value),object=context.lookup(ref)
   if(!(object instanceof PDFStream))fail()
   const type=String(object.dict.get(name('Subtype')))
   // Plain Form ancestry does not itself prevent a visual raster bake. The
   // caller checks the actual occurrence's inherited clips (including BBox).
   if(type==='/Image'){if(ordinal++===imageOrdinal)target={ref,object,rasterSafe:!unsafe&&!token.markedContent}}
   else if(type==='/Form'){
    if(ancestors.has(object))fail()
    walk(object,object.dict.lookupMaybe(name('Resources'),PDFDict)??resources,new Set(ancestors).add(object),unsafe||token.markedContent||object.dict.has(name('Group')))
   }else fail()
  }
 }
 try{
  walk(page.node.Contents(),page.node.Resources())
  if(!target)fail()
  const width=target.object.dict.lookup(name('Width'))?.asNumber?.(),height=target.object.dict.lookup(name('Height'))?.asNumber?.()
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192||width*height*4>32*1024*1024)fail()
  return {doc,target,width,height}

 }catch{fail()}
}


export async function createPdfImagePixelSource(bytes,pageIndex,imageOrdinal){
 const {doc,target,width,height}=await locateImage(bytes,pageIndex,imageOrdinal),context=doc.context
 for(let i=doc.getPageCount()-1;i>=0;i--)doc.removePage(i)
 const bare=doc.addPage([width,height]);bare.node.set(name('Resources'),context.obj({XObject:{IntrinsicImage:target.ref}}))
 bare.node.set(name('Contents'),context.register(context.flateStream(`q\n${width} 0 0 ${height} 0 0 cm\n/IntrinsicImage Do\nQ\n`)))
 const output=Buffer.from(await doc.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false}));if(output.length>MAX_BYTES)fail()
 return {bytes:output,width,height,rasterSafe:target.rasterSafe}
}

/** Replace one image's intrinsic pixels. Optional matrix maps its original unit
 * square into a new unit-space footprint; a Form wrapper leaves the original
 * content, inherited clipping/graphics state and draw order untouched. */
export async function replacePdfImagePixels(bytes,pageIndex,imageOrdinal,pixels,matrix){
 const {width,height,bgra}=pixels??{}
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192||width*height*4>32*1024*1024||!Buffer.isBuffer(bgra)||bgra.length!==width*height*4)fail()
 if(matrix!==undefined&&(!Array.isArray(matrix)||matrix.length!==6||!matrix.every(Number.isFinite)||Math.abs(matrix[0]*matrix[3]-matrix[1]*matrix[2])<1e-12))fail()
 const {doc,target}=await locateImage(await isolatePdfImageResources(bytes),pageIndex,imageOrdinal),context=doc.context
 const rgba=Buffer.from(bgra)
 for(let i=0;i<rgba.length;i+=4){rgba[i]=bgra[i+2];rgba[i+2]=bgra[i]}
 const png=new PNG({width,height});png.data.set(rgba)
 const image=await doc.embedPng(PNG.sync.write(png));await image.embed()
 const embedded=context.lookup(image.ref)
 if(!(embedded instanceof PDFStream))fail()
 if(matrix===undefined)context.assign(target.ref,embedded)
 else context.assign(target.ref,context.flateStream('/Pixels Do\n',{Type:'XObject',Subtype:'Form',BBox:[0,0,1,1],Matrix:matrix,Resources:{XObject:{Pixels:image.ref}}}))
 const output=Buffer.from(await doc.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false}));if(output.length>MAX_BYTES)fail()
 return output
}
