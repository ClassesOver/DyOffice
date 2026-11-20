import {inspectPdfImageDraftBytes} from './pdf-image-draft-pixels'
import type {PdfImageBytes} from '../shell/pdf-preview-skill'

const MAX_BYTES=5*1024*1024,MAX_RGBA=32*1024*1024
function invalid():never{throw Error('图片格式无效或超过大小限制。')}
function dimensions(width:number,height:number){
 if(width<1||height<1||width>8192||height>8192||width*height*4>MAX_RGBA)invalid()
 return {width,height}
}
function readBytes(base64:string){
 if(typeof base64!=='string'||!base64.length||base64.length>Math.ceil(MAX_BYTES/3)*4||base64.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))invalid()
 let raw:string;try{raw=atob(base64)}catch{invalid()}
 if(raw.length>MAX_BYTES||btoa(raw)!==base64)invalid()
 return Uint8Array.from(raw,c=>c.charCodeAt(0))
}
function inspectGif(b:Uint8Array){
 const text=(o:number,n:number)=>String.fromCharCode(...b.subarray(o,o+n))
 if(b.length<14||!['GIF87a','GIF89a'].includes(text(0,6)))invalid()
 const v=new DataView(b.buffer),size=dimensions(v.getUint16(6,true),v.getUint16(8,true))
 let o=13,frames=0
 const table=(flags:number)=>flags&128?3*(1<<((flags&7)+1)):0
 const skip=(n:number)=>{if(o+n>b.length)invalid();o+=n}
 const blocks=()=>{while(true){if(o>=b.length)invalid();const n=b[o++]!;if(!n)return;skip(n)}}
 skip(table(b[10]!))
 while(o<b.length){
  const type=b[o++]!
  if(type===59){if(!frames||o!==b.length)invalid();return size}
  if(type===33){skip(1);blocks();continue}
  if(type!==44||o+9>b.length)invalid()
  const x=v.getUint16(o,true),y=v.getUint16(o+2,true),w=v.getUint16(o+4,true),h=v.getUint16(o+6,true),flags=b[o+8]!
  dimensions(w,h);if(x+w>size.width||y+h>size.height)invalid()
  o+=9;skip(table(flags));if(o>=b.length||b[o]!<2||b[o]!>8)invalid();o++;blocks();frames++
 }
 invalid()
}
type Size={width:number;height:number}
function inspectWebp(b:Uint8Array){
 const v=new DataView(b.buffer),text=(o:number)=>String.fromCharCode(...b.subarray(o,o+4)),u24=(o:number)=>b[o]!+b[o+1]!*256+b[o+2]!*65536
 if(b.length<20||text(0)!=='RIFF'||text(8)!=='WEBP'||v.getUint32(4,true)+8!==b.length)invalid()
 function bitstream(kind:string,o:number,n:number):Size{
  if(kind==='VP8L'){
   if(n<5||b[o]!==47||b[o+4]!&224)invalid()
   const bits=v.getUint32(o+1,true);return dimensions((bits&16383)+1,((bits>>>14)&16383)+1)
  }
  if(n<10||b[o]!&1||b[o+3]!==157||b[o+4]!==1||b[o+5]!==42)invalid()
  return dimensions(v.getUint16(o+6,true)&16383,v.getUint16(o+8,true)&16383)
 }
 function chunks(start:number,end:number,visit:(kind:string,o:number,n:number)=>void){
  let o=start
  while(o<end){
   if(o+8>end)invalid();const kind=text(o),n=v.getUint32(o+4,true),data=o+8,next=data+n+(n%2)
   if(next>end)invalid();visit(kind,data,n);o=next
  }
 }
 let canvas:Size|undefined,image:Size|undefined,animated=false,animationHeader=false,frames=0
 chunks(12,b.length,(kind,o,n)=>{
  if(kind==='VP8X'){
   if(canvas||o!==20||n!==10||b[o]!&193||b[o+1]||b[o+2]||b[o+3])invalid()
   animated=!!(b[o]!&2);canvas=dimensions(u24(o+4)+1,u24(o+7)+1)
  }else if(kind==='ANIM'){
   if(!animated||animationHeader||n!==6||frames)invalid();animationHeader=true
  }else if(kind==='ANMF'){
   if(!animated||!animationHeader||!canvas||n<16)invalid()
   const x=u24(o)*2,y=u24(o+3)*2,w=u24(o+6)+1,h=u24(o+9)+1
   dimensions(w,h);if(x+w>canvas.width||y+h>canvas.height||b[o+15]!&252)invalid()
   let frame:Size|undefined
   chunks(o+16,o+n,(sub,p,length)=>{
    if(sub==='VP8 '||sub==='VP8L'){if(frame)invalid();frame=bitstream(sub,p,length)}
    else if(sub!=='ALPH')invalid()
   })
   if(!frame||frame.width!==w||frame.height!==h)invalid();frames++
  }else if(kind==='VP8 '||kind==='VP8L'){
   if(animated||image)invalid();image=bitstream(kind,o,n)
  }
 })
 if(animated){if(!frames)invalid();return canvas!}
 if(!image||canvas&&(canvas.width!==image.width||canvas.height!==image.height))invalid()
 return image
}
/** GIF/WebP 保留首帧；在浏览器解码前扫描所有帧的尺寸及容器边界。 */
export async function normalizePdfGeneratedImage(image:{mime:string;base64:string},signal?:AbortSignal):Promise<PdfImageBytes>{
 signal?.throwIfAborted()
 if(image?.mime==='image/png'||image?.mime==='image/jpeg'){
  const original:PdfImageBytes={mime:image.mime,base64:image.base64};inspectPdfImageDraftBytes(original);return original
 }
 if(!image||!['image/gif','image/webp'].includes(image.mime))invalid()
 const bytes=readBytes(image.base64),size=image.mime==='image/gif'?inspectGif(bytes):inspectWebp(bytes)
 signal?.throwIfAborted()
 const bitmap=await createImageBitmap(new Blob([bytes],{type:image.mime}),{imageOrientation:'none'})
 try{
  signal?.throwIfAborted();if(bitmap.width!==size.width||bitmap.height!==size.height)invalid()
  const canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height
  const context=canvas.getContext('2d');if(!context)throw Error('图片编辑画布不可用。')
  context.drawImage(bitmap,0,0)
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('图片编码失败。')),'image/png'))
  signal?.throwIfAborted();if(blob.size>MAX_BYTES)invalid()
  const outputBytes=new Uint8Array(await blob.arrayBuffer());signal?.throwIfAborted();let raw=''
  for(let i=0;i<outputBytes.length;i+=32768)raw+=String.fromCharCode(...outputBytes.subarray(i,i+32768))
  const output:PdfImageBytes={mime:'image/png',base64:btoa(raw)},header=inspectPdfImageDraftBytes(output)
  if(header.width!==size.width||header.height!==size.height)invalid()
  signal?.throwIfAborted();return output
 }finally{bitmap.close()}
}
