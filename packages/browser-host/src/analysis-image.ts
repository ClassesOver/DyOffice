import {analysisInsertLimits as limits, type PreparedAnalysisContent} from '../../web-contracts/src/analysis-document.ts'

type ImageContent=Extract<PreparedAnalysisContent,{kind:'image'}>
const fail=():never=>{throw new Error('Unsupported image content')}

/** Pixel size from the file header only; the bytes are never decoded or rendered here. */
export function imageDimensions(bytes:Uint8Array,mediaType:string):{width:number;height:number} {
 if(mediaType==='image/png'){
  const signature=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]
  if(bytes.length<24||signature.some((b,i)=>bytes[i]!==b)||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR')return fail()
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  return checked(view.getUint32(16),view.getUint32(20))
 }
 if(mediaType==='image/jpeg'){
  if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)return fail()
  let i=2
  while(i+9<bytes.length){
   if(bytes[i]!==0xff){i++;continue}
   const marker=bytes[i+1]!
   if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)){i+=2;continue}
   const length=(bytes[i+2]!<<8)|bytes[i+3]!
   if(length<2)return fail()
   // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC) carry the frame size.
   if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))return checked((bytes[i+7]!<<8)|bytes[i+8]!,(bytes[i+5]!<<8)|bytes[i+6]!)
   i+=2+length
  }
 }
 return fail()
}
function checked(width:number,height:number){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>limits.maxImageSide||height>limits.maxImageSide)return fail()
 return {width,height}
}

export function base64Bytes(base64:string):Uint8Array {
 if(typeof base64!=='string'||!base64||base64.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))return fail()
 const binary=atob(base64),bytes=new Uint8Array(binary.length)
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i)
 return bytes
}
export function bytesBase64(bytes:Uint8Array):string {
 let binary=''
 for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000))
 return btoa(binary)
}

/** Build image content from verified artifact bytes (PNG/JPEG only). */
/** Alt text from an untrusted label (a model string or a file name): control characters become spaces, then it is trimmed to the cell limit. */
export function imageAltText(label:string):string {
 return label.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,limits.maxCellUnits)
}
export function prepareImageContent(bytes:Uint8Array,mediaType:string,alt:string,provenance?:readonly string[]):ImageContent {
 if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>limits.maxImageBytes||(mediaType!=='image/png'&&mediaType!=='image/jpeg'))return fail()
 const {width,height}=imageDimensions(bytes,mediaType)
 return literalImage({kind:'image',mediaType,base64:bytesBase64(bytes),width,height,alt,...(provenance?{provenance}:{})})
}

/** Defense at the mutation boundary: re-validate every image field and the header against the bytes. */
export function literalImage(content:PreparedAnalysisContent):ImageContent {
 if(!content||content.kind!=='image'||(content.mediaType!=='image/png'&&content.mediaType!=='image/jpeg'))return fail()
 const bytes=base64Bytes(content.base64)
 if(bytes.byteLength>limits.maxImageBytes)return fail()
 const size=imageDimensions(bytes,content.mediaType)
 if(size.width!==content.width||size.height!==content.height)return fail()
 const control=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
 if(typeof content.alt!=='string'||content.alt.length>limits.maxCellUnits||control.test(content.alt))return fail()
 const provenance=content.provenance
 if(provenance!==undefined&&(!Array.isArray(provenance)||provenance.length>limits.maxRows||provenance.some(line=>typeof line!=='string'||line.length>limits.maxCellUnits||control.test(line))))return fail()
 return content
}

/** Fit an image inside a box, keeping its aspect ratio. */
export function fitInside(width:number,height:number,boxWidth:number,boxHeight:number,upscale=false){
 const scale=Math.min(boxWidth/width,boxHeight/height,upscale?Infinity:1)
 return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))}
}
