import {afterEach,expect,test,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot,Root} from 'react-dom/client'
import {act} from 'react'
import {LocalDraftCopy} from '../../src/editors/local-draft-copy'
let root:Root|undefined
let clicks=0,blobs:Blob[]=[]
let filenames:string[]=[]
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();clicks=0;blobs=[];filenames=[]})
async function fixture(serialize:()=>Promise<Uint8Array|null>,authority={current:()=>true,verify:async()=>true},seal?:(bytes:Uint8Array)=>Promise<Uint8Array>){
 const editor={serialize,save:vi.fn(()=>{throw Error('must not save')}),isDirty:()=>true},host=document.createElement('div');document.body.append(host)
 let current:typeof editor|null=editor
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(){clicks++;filenames.push(this.download)})
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn((blob:Blob)=>{blobs.push(blob);return 'blob:local-copy'}),revokeObjectURL:vi.fn()}))
 root=createRoot(host)
 await act(async()=>root!.render(h(LocalDraftCopy,{name:'private.docx',locale:'en',getEditor:()=>current,authority,seal})))
 return {button:()=>host.querySelector('button')!,host,editor,detach(){current=null},replace(){current={...editor}}}
}
test('draft bytes are serialized only after explicit click; not an implicit save',async()=>{
 const serialize=vi.fn(async()=>new Uint8Array([80,75,1,2])),f=await fixture(serialize)
 expect(serialize).not.toHaveBeenCalled();expect(clicks).toBe(0)
 await act(async()=>f.button().click())
 expect(serialize).toHaveBeenCalledTimes(1);expect(clicks).toBe(1)
 expect(f.editor.save).not.toHaveBeenCalled();expect(f.editor.isDirty()).toBe(true);expect(filenames).toEqual(['private-unsaved-draft.docx'])
 expect(blobs[0].size).toBe(4);expect(blobs[0].type).toContain('wordprocessingml.document')
 expect(f.host.textContent).toContain('Confirm the local copy before closing')
})
test('pending duplicate clicks serialize once and removed editor cannot download',async()=>{
 let finish!:(bytes:Uint8Array)=>void
 const serialize=vi.fn(()=>new Promise<Uint8Array>(r=>finish=r)),f=await fixture(serialize)
 await act(async()=>{f.button().click();f.button().click()})
 expect(serialize).toHaveBeenCalledTimes(1);f.detach()
 await act(async()=>finish(new Uint8Array([1])))
 expect(clicks).toBe(0)
})
test('component unmount suppresses late serialization result',async()=>{
 let finish!:(bytes:Uint8Array)=>void
 const f=await fixture(()=>new Promise<Uint8Array>(r=>finish=r))
 await act(async()=>f.button().click());await act(async()=>root!.unmount());root=undefined
 await act(async()=>finish(new Uint8Array([1])))
 expect(clicks).toBe(0)
})
for(const value of [null,new Uint8Array(),new Uint8Array(32*1024*1024+1)])test(`reject invalid draft size ${value?.length??'null'}`,async()=>{
 const f=await fixture(async()=>value);await act(async()=>f.button().click())
 expect(clicks).toBe(0);expect(f.host.textContent).toContain('Draft copy was not downloaded')
})

test('fixture DOCX bytes returned by serialize are copied unchanged without any HTTP calls',async()=>{
 const {readFile}=await import('node:fs/promises')
 const bytes=new Uint8Array(await readFile('../../packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx'))
 const fetch=vi.fn(()=>{throw Error('no network allowed')});vi.stubGlobal('fetch',fetch)
 const f=await fixture(async()=>bytes);await act(async()=>f.button().click())
 const actual=await new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(blobs[0])})
 expect(new Uint8Array(actual)).toEqual(bytes);expect(fetch).not.toHaveBeenCalled();expect(f.editor.save).not.toHaveBeenCalled()
})

test('another editor instance cannot receive an earlier snapshot download',async()=>{
 let finish!:(bytes:Uint8Array)=>void
 const f=await fixture(()=>new Promise<Uint8Array>(r=>finish=r))
 await act(async()=>f.button().click());f.replace()
 await act(async()=>finish(new Uint8Array([1])))
 expect(clicks).toBe(0);expect(f.host.textContent).toContain('Draft copy was not downloaded')
})
test('serializer failure does not leak its details or call save',async()=>{
 const f=await fixture(async()=>{throw Error('PRIVATE DOCUMENT CONTENT')})
 await act(async()=>f.button().click())
 expect(clicks).toBe(0);expect(f.host.textContent).not.toContain('PRIVATE DOCUMENT CONTENT')
 expect(f.host.textContent).toContain('keep this page open');expect(f.editor.save).not.toHaveBeenCalled()
})
test('unmount releases the requested local URL',async()=>{
 const f=await fixture(async()=>new Uint8Array([80,75]))
 await act(async()=>f.button().click())
 expect(URL.revokeObjectURL).not.toHaveBeenCalled()
 await act(async()=>root!.unmount());root=undefined
 expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-copy')
})

test('real proof binding blocks cookie rotation during serialization without server writes',async()=>{
 const {createDraftCopyAuthority}=await import('../../src/editors/draft-copy-authority')
 let token='a'.repeat(43)
 const send=vi.fn(async(_path:RequestInfo|URL,init?:RequestInit)=>{
  expect(init?.method).toBe('GET')
  return new Response(JSON.stringify({csrfToken:token}),{headers:{'content-type':'application/json'}})
 })
 const authority=await createDraftCopyAuthority(()=>true,send)
 const f=await fixture(async()=>{token='b'.repeat(43);return new Uint8Array([80,75])},authority)
 await act(async()=>f.button().click())
 expect(clicks).toBe(0);expect(f.editor.isDirty()).toBe(true);expect(f.editor.save).not.toHaveBeenCalled()
 expect(send).toHaveBeenCalledTimes(3)
})

test('an encrypted draft cannot download after the original login proof changes during sealing',async()=>{
 const source=new Uint8Array([80,75,1,2])
 let valid=true
 const authority={current:()=>valid,verify:async()=>valid}
 const seal=vi.fn(async()=>{
  valid=false
  return new Uint8Array([0xd0,0xcf,0x11,0xe0])
 })
 const f=await fixture(async()=>source,authority,seal)
 await act(async()=>f.button().click())
 expect(seal).toHaveBeenCalledWith(source)
 expect(clicks).toBe(0)
 expect(f.editor.save).not.toHaveBeenCalled()
})
