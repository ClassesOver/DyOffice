export const WEB_MODEL3D_MAX_BYTES=8*1024*1024

/** The browser renderer can load only resources bundled into the selected GLB. */
export function isSelfContainedGlb(bytes:Uint8Array):boolean{
  if(bytes.byteLength<20||bytes.byteLength>WEB_MODEL3D_MAX_BYTES)return false
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  if(view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==bytes.byteLength||view.getUint32(16,true)!==0x4e4f534a)return false
  const length=view.getUint32(12,true)
  if(length<4||length%4!==0||20+length>bytes.byteLength)return false
  try{
    const root=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(20,20+length)))
    if(root?.asset?.version!=='2.0')return false
    function check(value:unknown,depth:number):boolean{
      if(depth>128)return false
      if(!value||typeof value!=='object')return true
      return Object.entries(value).every(([key,child])=>key==='uri'
        ? typeof child==='string'&&/^data:(?:image\/(?:png|jpeg|webp)|application\/(?:octet-stream|gltf-buffer));base64,[A-Za-z0-9+/]+={0,2}$/i.test(child)
        : check(child,depth+1))
    }
    return check(root,0)
  }catch{return false}
}
