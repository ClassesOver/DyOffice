import {afterEach,expect,it,vi} from 'vitest'
import codecs from '../fixtures/pdf-image-content-codecs.json'
import {normalizePdfGeneratedImage} from '../../src/editors/pdf-generated-image'
const png={mime:'image/png' as const,base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='}
const data=(mime:string,bytes:number[])=>({mime,base64:btoa(String.fromCharCode(...bytes))})
const le=(n:number,count=4)=>Array.from({length:count},(_,i)=>(n>>>i*8)&255)
const str=(s:string)=>Array.from(s,c=>c.charCodeAt(0))
const chunk=(name:string,b:number[])=>[...str(name),...le(b.length),...b,...(b.length%2?[0]:[])]
const vp8l=(w=1,h=1)=>[47,...le((w-1)|((h-1)<<14))]
const webp=(chunks:number[][])=>{const b=[...str('WEBP'),...chunks.flat()];return data('image/webp',[...str('RIFF'),...le(b.length),...b])}
const extended=(w=1,h=1)=>chunk('VP8X',[2,0,0,0,...le(w-1,3),...le(h-1,3)])
const frame=(w=1,h=1,x=0)=>chunk('ANMF',[...le(x/2,3),0,0,0,...le(w-1,3),...le(h-1,3),0,0,0,0,...chunk('VP8L',vp8l(w,h))])
const animated=(w=1,h=1,x=0)=>webp([extended(),chunk('ANIM',[0,0,0,0,0,0]),frame(w,h,x)])
const gif=(w=1,h=1,fw=1,fh=1,x=0)=>data('image/gif',[...str('GIF89a'),...le(w,2),...le(h,2),0,0,0,44,...le(x,2),0,0,...le(fw,2),...le(fh,2),0,2,2,68,1,0,59])
function browser(width=1,height=1){
 const close=vi.fn(),drawImage=vi.fn()
 vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width,height,close})))
 vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>({drawImage}),toBlob:(cb:(b:Blob)=>void)=>cb(new Blob([Uint8Array.from(atob(png.base64),c=>c.charCodeAt(0))],{type:'image/png'}))})})
 return {close,drawImage}
}
afterEach(()=>vi.unstubAllGlobals())
it('preserves valid PNG bytes',async()=>expect(await normalizePdfGeneratedImage(png)).toEqual(png))
it.each([gif(),webp([chunk('VP8L',vp8l())]),animated()])('converts first frame to PNG',async input=>{const b=browser();expect(await normalizePdfGeneratedImage(input)).toEqual(png);expect(b.drawImage).toHaveBeenCalledOnce();expect(b.close).toHaveBeenCalledOnce()})
it.each([gif(0),gif(8193),gif(4096,4096),gif(1,1,2),gif(1,1,1,1,1),animated(2),animated(1,1,2),webp([chunk('VP8L',vp8l(8193))]),webp([extended(4096,4096),chunk('ANIM',[0,0,0,0,0,0]),frame()])])('rejects dimensions before decode',async input=>{const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode);await expect(normalizePdfGeneratedImage(input)).rejects.toThrow();expect(decode).not.toHaveBeenCalled()})
it.each([{mime:'image/svg+xml',base64:png.base64},{mime:'image/gif',base64:'AA=='},{...gif(),base64:gif().base64+'='},webp([chunk('ANMF',[])])])('rejects malformed input',async input=>await expect(normalizePdfGeneratedImage(input)).rejects.toThrow())
it('keeps PNG size guard',async()=>{const bytes=Uint8Array.from(atob(png.base64),c=>c.charCodeAt(0));new DataView(bytes.buffer).setUint32(16,8193);await expect(normalizePdfGeneratedImage(data('image/png',Array.from(bytes)))).rejects.toThrow()})
it('rejects truncated containers',async()=>{for(const input of [gif(),animated()])await expect(normalizePdfGeneratedImage({...input,base64:btoa(atob(input.base64).slice(0,-1))})).rejects.toThrow()})
it('rejects pre-aborted calls without decoding',async()=>{const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode);const c=new AbortController();c.abort();await expect(normalizePdfGeneratedImage(gif(),c.signal)).rejects.toThrow();expect(decode).not.toHaveBeenCalled()})
it('closes bitmap on cancellation',async()=>{const b=browser(),c=new AbortController();vi.stubGlobal('createImageBitmap',vi.fn(async()=>{c.abort();return {width:1,height:1,close:b.close}}));await expect(normalizePdfGeneratedImage(gif(),c.signal)).rejects.toThrow();expect(b.close).toHaveBeenCalledOnce();expect(b.drawImage).not.toHaveBeenCalled()})
it('closes bitmap on header mismatch',async()=>{const b=browser(2,1);await expect(normalizePdfGeneratedImage(gif())).rejects.toThrow();expect(b.close).toHaveBeenCalledOnce()})

it('checks every later GIF and WebP frame before decoding',async()=>{
 const g=atob(gif().base64),bad=atob(gif(1,1,2).base64)
 const laterGif={mime:'image/gif',base64:btoa(g.slice(0,-1)+bad.slice(13))}
 const laterWebp=webp([extended(),chunk('ANIM',[0,0,0,0,0,0]),frame(),frame(2)])
 const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode)
 for(const input of [laterGif,laterWebp])await expect(normalizePdfGeneratedImage(input)).rejects.toThrow()
 expect(decode).not.toHaveBeenCalled()
})
it('rejects nested frame bitstream dimensions inconsistent with ANMF',async()=>{
 const broken=chunk('ANMF',[...Array(16).fill(0),...chunk('VP8L',vp8l(2))])
 await expect(normalizePdfGeneratedImage(webp([extended(),chunk('ANIM',[0,0,0,0,0,0]),broken]))).rejects.toThrow()
})
it('rejects encoded output that exceeds byte budget and closes bitmap',async()=>{
 const b=browser();vi.stubGlobal('document',{createElement:()=>({getContext:()=>({drawImage:vi.fn()}),toBlob:(cb:(b:Blob)=>void)=>cb(new Blob([new Uint8Array(5*1024*1024+1)]))})})
 await expect(normalizePdfGeneratedImage(gif())).rejects.toThrow();expect(b.close).toHaveBeenCalledOnce()
})
it('rejects encoding failure and closes bitmap',async()=>{
 const b=browser();vi.stubGlobal('document',{createElement:()=>({getContext:()=>({drawImage:vi.fn()}),toBlob:(cb:(b:null)=>void)=>cb(null)})})
 await expect(normalizePdfGeneratedImage(gif())).rejects.toThrow();expect(b.close).toHaveBeenCalledOnce()
})
it('honors cancellation while PNG encoding is pending',async()=>{
 const b=browser(),c=new AbortController();vi.stubGlobal('document',{createElement:()=>({getContext:()=>({drawImage:vi.fn()}),toBlob:(cb:(b:Blob)=>void)=>{c.abort();cb(new Blob())}})})
 await expect(normalizePdfGeneratedImage(gif(),c.signal)).rejects.toThrow();expect(b.close).toHaveBeenCalledOnce()
})
it('rejects input beyond byte budget before allocating browser decoder',async()=>{
 const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode)
 await expect(normalizePdfGeneratedImage({mime:'image/gif',base64:'A'.repeat(Math.ceil(5*1024*1024/3)*4+4)})).rejects.toThrow()
 expect(decode).not.toHaveBeenCalled()
})

it('preserves valid JPEG bytes without browser conversion',async()=>{const input={mime:'image/jpeg' as const,base64:codecs.rgb.base64};expect(await normalizePdfGeneratedImage(input)).toEqual(input)})
