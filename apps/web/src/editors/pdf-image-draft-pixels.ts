import {flipPixels,multiplyAlpha} from '../../../pdf/src/renderer/image-bake'
import {removeBackground,type PixelImage} from '../../../../packages/ui/src/cutout'
import type {PdfImageBytes} from './pdf-types'

export type PdfImageDraftBakeOperation=
 |{kind:'rotate';direction:'cw'|'ccw'|'180'}
 |{kind:'flip';axis:'horizontal'|'vertical'}
 |{kind:'opacity';value:number}
 |{kind:'crop';left?:number;top?:number;right?:number;bottom?:number}
 |{kind:'cutout';tolerance:number}
export type TransformPdfImageDraftPixels=(image:PdfImageBytes,operation:PdfImageDraftBakeOperation,signal?:AbortSignal)=>Promise<PdfImageBytes>
const MAX_BYTES=5*1024*1024,MAX_RGBA=32*1024*1024
function invalid():never{throw Error('图片格式无效或超过大小限制。')}
/** Decoded byte length of a padded base64 string, without decoding it. */
export function base64ByteSize(base64:string){return base64.length/4*3-(base64.endsWith('==')?2:base64.endsWith('=')?1:0)}
function dimensions(width:number,height:number){if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192||width*height*4>MAX_RGBA)invalid();return {width,height}}
/** 浏览器分配像素缓冲前，先检查有界的文件头和尺寸。 */
export function inspectPdfImageDraftBytes(image:PdfImageBytes){
 if(!image||!['image/png','image/jpeg'].includes(image.mime)||typeof image.base64!=='string'||!image.base64.length||image.base64.length>Math.ceil(MAX_BYTES/3)*4||image.base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64))invalid()
 let raw:string;try{raw=atob(image.base64)}catch{invalid()}
 if(raw.length>MAX_BYTES||btoa(raw)!==image.base64)invalid()
 const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),view=new DataView(bytes.buffer)
 let width=0,height=0
 if(image.mime==='image/png'){
  if(bytes.length<33||![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b)||view.getUint32(8)!==13||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR')invalid()
  width=view.getUint32(16);height=view.getUint32(20)
 }else{
  if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)invalid()
  let offset=2
  while(offset+4<=bytes.length){
   if(bytes[offset++]!==255)break
   while(bytes[offset]===255)offset++
   const marker=bytes[offset++]!
   if(marker===217||marker===218)break
   if(marker===1||marker>=208&&marker<=215)continue
   if(offset+2>bytes.length)break
   const length=view.getUint16(offset)
   if(length<2||offset+length>bytes.length)break
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
    if(length<8)break
    const count=bytes[offset+7]!
    if(count<1||count>4||length!==8+count*3)break
    width=view.getUint16(offset+5);height=view.getUint16(offset+3);break
   }
   offset+=length
  }
 }
 return {...dimensions(width,height),bytes,byteLength:bytes.length}
}
export function validatePdfImageDraftBake(operation:PdfImageDraftBakeOperation){
 if(!operation||typeof operation!=='object'||Array.isArray(operation))throw Error('图片操作无效。')
 const allowed:Record<string,string[]>={rotate:['direction'],flip:['axis'],opacity:['value'],crop:['left','top','right','bottom'],cutout:['tolerance']}
 const fields=allowed[operation.kind]
 if(!fields||Object.keys(operation).some(key=>key!=='kind'&&!fields.includes(key)))throw Error('图片操作无效。')
 if(operation.kind==='rotate'&&!['cw','ccw','180'].includes(operation.direction)||operation.kind==='flip'&&!['horizontal','vertical'].includes(operation.axis)||operation.kind==='opacity'&&(!Number.isFinite(operation.value)||operation.value<0||operation.value>1)||operation.kind==='cutout'&&(!Number.isFinite(operation.tolerance)||operation.tolerance<0||operation.tolerance>100))throw Error('图片操作参数无效。')
 if(operation.kind==='crop'){
  const values=[operation.left??0,operation.top??0,operation.right??0,operation.bottom??0]
  if(values.some(value=>!Number.isFinite(value)||value<0||value>=1)||!values.some(value=>value>0)||values[0]!+values[2]!>=1||values[1]!+values[3]!>=1)throw Error('图片裁剪参数无效。')
 }
}
export function getPdfImageDraftCrop(width:number,height:number,operation:Extract<PdfImageDraftBakeOperation,{kind:'crop'}>){
 validatePdfImageDraftBake(operation)
 const x=Math.round((operation.left??0)*width),y=Math.round((operation.top??0)*height),right=Math.round((1-(operation.right??0))*width),bottom=Math.round((1-(operation.bottom??0))*height)
 if(right<=x||bottom<=y||x===0&&y===0&&right===width&&bottom===height)throw Error('裁剪必须保留至少一个像素并移除部分像素。')
 return {x,y,width:right-x,height:bottom-y}
}
export function applyPdfImageDraftPixels(source:PixelImage,operation:PdfImageDraftBakeOperation):PixelImage{
 dimensions(source.width,source.height);validatePdfImageDraftBake(operation)
 if(source.data.length!==source.width*source.height*4)invalid()
 if(operation.kind==='flip')return {width:source.width,height:source.height,data:flipPixels(source,operation.axis==='horizontal'?'h':'v')}
 if(operation.kind==='opacity')return {width:source.width,height:source.height,data:multiplyAlpha(source,operation.value)}
 if(operation.kind==='cutout')return {width:source.width,height:source.height,data:removeBackground(source,operation.tolerance).data}
 if(operation.kind==='crop'){
  const crop=getPdfImageDraftCrop(source.width,source.height,operation),data=new Uint8ClampedArray(crop.width*crop.height*4)
  for(let y=0;y<crop.height;y++)data.set(source.data.subarray(((y+crop.y)*source.width+crop.x)*4,((y+crop.y)*source.width+crop.x+crop.width)*4),y*crop.width*4)
  return {width:crop.width,height:crop.height,data}
 }
 const swap=operation.direction!=='180',width=swap?source.height:source.width,height=swap?source.width:source.height,data=new Uint8ClampedArray(source.data.length)
 for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
  const dx=operation.direction==='cw'?source.height-1-y:operation.direction==='ccw'?y:source.width-1-x,dy=operation.direction==='cw'?x:operation.direction==='ccw'?source.width-1-x:source.height-1-y
  data.set(source.data.subarray((y*source.width+x)*4,(y*source.width+x+1)*4),(dy*width+dx)*4)
 }
 return {width,height,data}
}
export const transformPdfImageDraftPixels:TransformPdfImageDraftPixels=async(image,operation,signal)=>{
 signal?.throwIfAborted();validatePdfImageDraftBake(operation)
 const header=inspectPdfImageDraftBytes(image),bitmap=await createImageBitmap(new Blob([header.bytes],{type:image.mime}),{imageOrientation:'none'})
 try{
  signal?.throwIfAborted()
  if(bitmap.width!==header.width||bitmap.height!==header.height)invalid()
  const canvas=document.createElement('canvas');canvas.width=header.width;canvas.height=header.height
  const context=canvas.getContext('2d');if(!context)throw Error('图片编辑画布不可用。')
  context.drawImage(bitmap,0,0)
  const result=applyPdfImageDraftPixels(context.getImageData(0,0,header.width,header.height),operation)
  canvas.width=result.width;canvas.height=result.height
  context.putImageData(new ImageData(new Uint8ClampedArray(result.data),result.width,result.height),0,0)
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('图片编码失败。')),'image/png'))
  signal?.throwIfAborted();if(blob.size>MAX_BYTES)invalid()
  const bytes=new Uint8Array(await blob.arrayBuffer());let raw=''
  for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768))
  const output:PdfImageBytes={mime:'image/png',base64:btoa(raw)}
  inspectPdfImageDraftBytes(output);signal?.throwIfAborted();return output
 }finally{bitmap.close()}
}
