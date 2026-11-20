import {act, createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {expect, test, vi} from 'vitest'

const {createEditorAssistant,mountPdfEditor,preparePdfFormMark} = vi.hoisted(() => ({createEditorAssistant: vi.fn(),mountPdfEditor:vi.fn(),preparePdfFormMark:vi.fn()}))
vi.mock('../../src/editors/assistant', () => ({createEditorAssistant}))
vi.mock('../../src/editors/pdf-viewer', () => ({mountPdfEditor,preparePdfFormMark}))
vi.mock('../../src/editors/shared-editor-assistant', () => ({SharedEditorAssistant:()=>null}))

import {DocumentPreview} from '../../src/shell/DocumentPreview'
import {createDocumentImageApi} from '../../src/editors/web-ai-media-api'

test('PDF pending image and text share one save while raster preview preserves the document layer',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)

 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"><canvas></canvas></div></figure>';return {pages:[{page:1,text:'Body',width:500,height:600}],outline:[]}})
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([37,80,68,70]))))
 const calls:Array<{path:string;body:any}>=[],png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
 const imageApi=createDocumentImageApi({generateImage:async()=>({url:'data:image/png;base64,'+png}),fetchImage:async()=>{throw Error('Generated image must stay local')}})
 const generated=await imageApi.generateImage({prompt:'A red pixel'})
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn(),mediaApi:imageApi})
 const request=vi.fn(async(path:string,_method?:string,body?:any)=>{
  calls.push({path,body})
  if(path.endsWith('/apply-ops/query'))return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0='}
  if(path==='/api/v1/files/mixed')return {file:{fileId:'mixed',revision:'r1'},downloadEndpoint:'/api/v1/files/mixed/content?revision=r1'}
  if(path.endsWith('/image-inserts/query'))return {revision:'r1',image:{page:1,x:40,y:50,width:100,height:50,layer:'below_text',pixelWidth:1,pixelHeight:1},edit:{kind:'insertImage',pageIndex:0,rect:[40,500,140,550],rotate:0,layer:'belowText',image:body.operation.image.base64}}
  if(path.endsWith('/text-inserts/query'))return {revision:'r1',inserts:body.operations.map((op:any)=>({pageIndex:0,origin:[op.x??80,600-(op.y??72)],text:op.text,fontSize:op.font_size??20,color:[0,0,0],rotate:0,lineLeading:1.2})),blocks:body.operations.map((op:any)=>({page:1,text:op.text,x:80,y:72,width:100,height:24,font_size:20,color:'#000000',align:'left',line_widths:[100]}))}
  if(path.endsWith('/draft-inserts/query'))return {revision:'r1',pages:[{page:1,width:500,height:600,png}]}
  if(path.endsWith('/lease'))return {leaseEpoch:1}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'mixed',uploadId:'upload',baseRevision:'r1',leaseEpoch:1,idempotencyKey:'key'}}
  if(path.endsWith('/commits'))return {fileId:'mixed',revision:'r2'}
  return {}
 })
 document.body.innerHTML='<div id="mixed-pdf"></div>'
 const root=createRoot(document.getElementById('mixed-pdf')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'mixed',name:'Mixed.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)![4][0]
  await act(async()=>{const result=await skill.executeTool({id:'image',name:'insert_image',input:{page:1,url:generated.url}});expect(result.isError).not.toBe(true)})
  expect(calls.some(call=>call.path.endsWith('/uploads'))).toBe(false)
  expect(document.querySelector('[aria-label="待保存图片覆盖层"]')).not.toBeNull()
  expect(calls.some(call=>call.path.endsWith('/apply-ops/query'))).toBe(true)
  const NativeFileReader=FileReader;let releaseReader!:()=>void
  vi.stubGlobal('FileReader',class extends NativeFileReader{readAsDataURL(blob:Blob){releaseReader=()=>super.readAsDataURL(blob)}})
  const picker=document.querySelector<HTMLInputElement>('[aria-label="替换待保存图片"]')!
  Object.defineProperty(picker,'files',{value:[new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'replacement.png',{type:'image/png'})],configurable:true})
  await act(async()=>picker.dispatchEvent(new Event('change',{bubbles:true})))
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='保存新版本')!.disabled).toBe(true)
  expect(calls.some(call=>call.path.endsWith('/uploads'))).toBe(false)
  await act(async()=>{releaseReader();await new Promise(resolve=>setTimeout(resolve,20))})
  vi.stubGlobal('FileReader',NativeFileReader)
  await act(async()=>{await skill.executeTool({id:'text',name:'insert_text',input:{page:1,text:'New'}})})
  const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='保存新版本')!
  expect(button.disabled).toBe(false)
  await act(async()=>button.click())
  expect(calls.filter(call=>call.path.endsWith('/apply-ops/uploads'))).toHaveLength(1)
  expect(calls.find(call=>call.path.endsWith('/apply-ops/uploads'))?.body.snapshot.textInserts).toHaveLength(1)
  expect(calls.filter(call=>call.path.endsWith('/commits'))).toHaveLength(1)
  expect(document.querySelector('[aria-label="待保存图片覆盖层"]')).toBeNull()
 }finally{await act(async()=>root.unmount());document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('PDF inserted text stays editable and undoable without upload until the user saves one batch',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"></div></figure>';return {pages:[{page:1,text:'Body',width:500,height:600}],outline:[]}})
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([37,80,68,70]))))
 const calls:Array<{path:string;body:any}>=[]
 const request=vi.fn(async(path:string,_method?:string,body?:any)=>{
  calls.push({path,body})
  if(path.endsWith('/apply-ops/query'))return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0='}
  if(path==='/api/v1/files/draft')return {file:{fileId:'draft',revision:'r1'},downloadEndpoint:'/api/v1/files/draft/content?revision=r1'}
  if(path.endsWith('/query'))return {revision:'r1',inserts:body.operations.map((op:any)=>({pageIndex:0,origin:[op.x??80,600-(op.y??72)],text:op.text,fontSize:op.font_size??20,color:[0,0,0],rotate:0,lineLeading:1.2})),blocks:body.operations.map((op:any)=>({page:1,text:op.text,x:op.x??80,y:op.y??72,width:100,height:24,font_size:20,color:'#000000',align:'left',line_widths:[100]}))}
  if(path.endsWith('/lease'))return {leaseEpoch:1}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'draft',uploadId:'upload',baseRevision:'r1',leaseEpoch:1,idempotencyKey:'key'}}
  if(path.endsWith('/commits'))return {fileId:'draft',revision:'r2'}
  return {}
 })
 document.body.innerHTML='<div id="pending-pdf"></div>'
 const root=createRoot(document.getElementById('pending-pdf')!)
 let guard:(()=>boolean|Promise<boolean>)|null=null
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'draft',name:'Draft.pdf',format:'pdf',request,assistantEnabled:true,registerGuard:(_id,value)=>guard=value}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)![4][0]
  let inserted:any
  await act(async()=>{inserted=await skill.executeTool({id:'insert',name:'insert_text',input:{page:1,text:'Draft'}})})
  expect(inserted.output).toContain('T')
  expect(calls.some(call=>call.path.endsWith('/uploads'))).toBe(false)
  expect(document.querySelector('[aria-label="待保存文字覆盖层"]')).not.toBeNull()
  await act(async()=>{expect(await guard!()).toBe(false)})
  await act(async()=>{expect((await skill.executeTool({id:'blocked',name:'edit_text',input:{page:1,old_text:'Body',new_text:'Unsafe'}})).isError).toBe(true)})
  expect(calls.some(call=>call.path.endsWith('/uploads'))).toBe(false)
  const listed=await skill.executeTool({id:'list',name:'list_inserted_text',input:{}})
  const id=JSON.parse(listed.output.slice(listed.output.indexOf('['),listed.output.lastIndexOf(']')+1))[0].id
  await act(async()=>{await skill.executeTool({id:'edit',name:'edit_inserted_text',input:{id,text:'Final'}});await skill.executeTool({id:'move',name:'move_inserted_text',input:{id,dx:20,dy:10}});await skill.executeTool({id:'delete',name:'delete_inserted_text',input:{id}})})
  expect(document.querySelector('[aria-label="待保存文字覆盖层"]')).toBeNull()
  const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===name)!
  await act(async()=>button('撤销修改').click())
  expect(document.querySelector('[aria-label="待保存文字覆盖层"]')).not.toBeNull()
  await act(async()=>button('保存新版本').click())
  expect(calls.filter(call=>call.path.endsWith('/apply-ops/uploads'))).toHaveLength(1)
  expect(calls.find(call=>call.path.endsWith('/apply-ops/uploads'))?.body.snapshot.textInserts[0].input.text).toBe('Final')
  expect(calls.filter(call=>call.path.endsWith('/commits'))).toHaveLength(1)
  expect(document.querySelector('[aria-label="待保存文字覆盖层"]')).toBeNull()
  expect(await guard!()).toBe(true)
 }finally{await act(async()=>root.unmount());document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('PDF document creation keeps the initiating workspace and waits for its saved receipt',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 document.body.innerHTML='<div id="pdf-create-test"></div>'
 const root=createRoot(document.getElementById('pdf-create-test')!)
 const receipt={fileId:'created',revision:'saved',sha256:'a'.repeat(64),size:100}
 let resolveSave!:(value:typeof receipt)=>void
 const save=vi.fn(()=>new Promise<typeof receipt>(resolve=>{resolveSave=resolve}))
 const prepare=vi.fn(async()=>({docxEditable:true,save})),replacement=vi.fn(async()=>({docxEditable:true,save:vi.fn()}))
 const props={fileId:'source',name:'source.pdf',format:'pdf' as const,request:vi.fn(async()=>{throw Error('not loaded')}),assistantEnabled:true,docxCreationAvailable:true}
 try{
  await act(async()=>root.render(h(DocumentPreview,{...props,prepareDocument:prepare})))
  const skills=createEditorAssistant.mock.calls.at(-1)![4]
  const skill=skills.find((entry:{id:string})=>entry.id==='pdf-create-document')
  expect(skill.tools[0].inputSchema.properties.type.enum).toEqual(['pdf','docx'])
  let settled=false
  const result=skill.executeTool({id:'create',name:'create_document',input:{type:'docx',title:'Report',content:'<p>Body</p>'}}).then((value:unknown)=>{settled=true;return value})
  await vi.waitFor(()=>expect(save).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  await act(async()=>root.render(h(DocumentPreview,{...props,prepareDocument:replacement})))
  expect(createEditorAssistant).toHaveBeenCalledOnce()
  resolveSave(receipt)
  expect(await result).toMatchObject({mutated:true})
  expect(prepare).toHaveBeenCalledOnce();expect(replacement).not.toHaveBeenCalled()
 }finally{
  await act(async()=>root.unmount());document.body.innerHTML='';createEditorAssistant.mockReset()
 }
})

test('PDF assistant initialization failure is visible and retryable', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  createEditorAssistant.mockRejectedValue(new Error('unavailable'))
  document.body.innerHTML = '<div id="pdf-preview-test"></div>'
  const root = createRoot(document.getElementById('pdf-preview-test')!)
  const request = vi.fn(async () => { throw new Error('file service unavailable') })
  try {
    await act(async () => root.render(h(DocumentPreview, {
      fileId: 'file-1', name: 'report.pdf', format: 'pdf', request, assistantEnabled: true,
    })))
    expect(document.body.textContent).toContain('AI 助手加载失败')
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '重试助手')!
    expect(retry.disabled).toBe(false)
    await act(async () => retry.click())
    expect(createEditorAssistant).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    document.body.innerHTML = ''
    createEditorAssistant.mockReset()
  }
})

test('PDF page operations refresh page count, annotations and navigation before the next tool call',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 let pageCount=3,revision='rev1',width=612,height=792
 const render=()=>({pages:Array.from({length:pageCount},(_,i)=>({page:i+1,text:`Page ${i+1} ${revision}`,width,height,annotations:[{id:`${revision}-${i+1}`,type:'Text',author:'Original author',contents:'Saved note'}]})),outline:[],formFields:[{name:`Field-${revision}`,kind:'text',pageIndex:0,value:`Value-${revision}`,checked:false,required:false,readOnly:false,options:[]}]})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{
  const result=render();host.replaceChildren(...result.pages.map(page=>{const node=document.createElement('figure');node.dataset.pdfPage=String(page.page);node.scrollIntoView=vi.fn();return node}));return result
 })
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const calls:Array<[string,string|undefined,unknown,AbortSignal|undefined]>=[]
 const request=vi.fn(async(path:string,method?:string,body?:unknown,signal?:AbortSignal)=>{
  calls.push([path,method,body,signal])
  if(path.endsWith('/apply-ops/query')){pageCount=3-(body as any).snapshot.deleted.length;return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0='}}
  if(path==='/api/v1/files/file-1')return {file:{fileId:'file-1',revision},downloadEndpoint:`/api/v1/files/file-1/content?revision=${revision}`}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/page-ops/uploads')||path.endsWith('/apply-ops/uploads'))return {commitInput:{fileId:'file-1',uploadId:'upload',baseRevision:revision,leaseEpoch:7,idempotencyKey:'key'}}
  if(path.endsWith('/commits')){
   if(revision==='rev1'){pageCount=1;revision='rev2'}
   else if(revision==='rev2'){pageCount=2;revision='rev3'}
   else if(revision==='rev3'){width=595;height=842;revision='rev4'}
   else{width=297.5;revision='rev5'}
   return {fileId:'file-1',revision}
  }
  return {}
 })
 document.body.innerHTML='<div id="pdf-page-ops-test"></div>'
 const root=createRoot(document.getElementById('pdf-page-ops-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'file-1',name:'report.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)?.[4]?.[0]
  expect((await skill.executeTool({id:'initial-fields',name:'list_form_fields',input:{}})).output).toContain('Field-rev1')
  const beforeDry=calls.length
  const dry=await skill.executeTool({id:'dry',name:'apply_ops',input:{ops:[{op:'deletePage',page:3}],dry_run:true}})
  expect(dry.mutated).toBe(false);expect(dry.isError).toBeUndefined();expect(calls).toHaveLength(beforeDry)
  await act(async()=>{expect((await skill.executeTool({id:'goto',name:'goto_page',input:{page:3}})).isError).toBeUndefined()})
  expect((document.querySelector('[aria-label="选择旋转页码"]') as HTMLSelectElement).value).toBe('3')
  const controller=new AbortController()
  await act(async()=>{expect((await skill.executeTool({id:'delete',name:'apply_ops',input:{ops:[{op:'deletePage',page:2},{op:'deletePage',page:3}]}},controller.signal)).mutated).toBe(true)})
  expect(calls.some(c=>c[0].endsWith('/uploads'))).toBe(false)
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='保存新版本')!.click())
  expect((document.querySelector('[aria-label="选择旋转页码"]') as HTMLSelectElement).value).toBe('1')
  expect((document.querySelector('[aria-label="跳转到 PDF 页码"]') as HTMLInputElement).getAttribute('aria-valuemax')).toBe('1')
  expect((document.querySelector('[aria-label="跳转到 PDF 页码"]') as HTMLInputElement).value).toBe('1')
  expect((await skill.executeTool({id:'stale-page',name:'goto_page',input:{page:3}})).isError).toBe(true)
  expect((await skill.executeTool({id:'annotations',name:'read_annotations',input:{}})).output).toContain('rev2-1')
  expect((await skill.executeTool({id:'read',name:'read_pages',input:{start:1}})).output).toContain('Page 1 rev2')
  await act(async()=>{expect((await skill.executeTool({id:'blank',name:'insert_blank_page',input:{after_page:1}},controller.signal)).mutated).toBe(true)})
  const writes=calls.filter(call=>call[0].endsWith('/page-ops/uploads'))
  expect(writes.map(call=>call[2])).toEqual([
   expect.objectContaining({baseRevision:'rev2',operations:[{op:'insertBlankPage',afterPage:1}]}),
  ])
  expect(writes.every(call=>call[3]===controller.signal)).toBe(true)
  expect((document.querySelector('[aria-label="跳转到 PDF 页码"]') as HTMLInputElement).getAttribute('aria-valuemax')).toBe('2')
  await act(async()=>{expect((await skill.executeTool({id:'resize',name:'set_page_size',input:{preset:'A4'}},controller.signal)).mutated).toBe(true)})
  expect((await skill.executeTool({id:'size-read',name:'read_pages',input:{start:1}})).output).toContain('595 × 842 pt')
  const fieldsAfterSave=await skill.executeTool({id:'saved-fields',name:'list_form_fields',input:{}})
  expect(fieldsAfterSave.output).toContain('Field-rev4');expect(fieldsAfterSave.output).not.toContain('Field-rev1')
  expect((await skill.executeTool({id:'size-notes',name:'read_annotations',input:{}})).output).toContain('rev4-1')
  await act(async()=>{const crop=await skill.executeTool({id:'crop',name:'crop_pages',input:{pages:'all',left:0,top:0,right:0.5,bottom:1}},controller.signal);expect(crop.mutated).toBe(true);expect(crop.output).toMatch(/not.*redact/i)})
  expect((await skill.executeTool({id:'crop-read',name:'read_pages',input:{start:1}})).output).toContain('297.5 × 842 pt')
  expect((await skill.executeTool({id:'crop-notes',name:'read_annotations',input:{}})).output).toContain('rev5-1')
  expect(calls.filter(call=>call[0].endsWith('/page-ops/uploads')).slice(-2).map(call=>call[2])).toEqual([
   expect.objectContaining({baseRevision:'rev3',operations:[{op:'setPageSize',width:595,height:842}]}),
   expect.objectContaining({baseRevision:'rev4',operations:[{op:'cropPages',pages:[1,2],left:0,top:0,right:0.5,bottom:1}]}),
  ])
  expect(vi.mocked(fetch).mock.calls.map(call=>call[0])).toEqual(expect.arrayContaining(['/api/v1/files/file-1/content?revision=rev4','/api/v1/files/file-1/content?revision=rev5']))

  mountPdfEditor.mockRejectedValueOnce(Error('refresh failed'))
  await act(async()=>{await skill.executeTool({id:'failed-refresh',name:'set_page_size',input:{preset:'A4'}})})
  const failedSnapshot=await skill.executeTool({id:'unavailable-fields',name:'list_form_fields',input:{}})
  expect(failedSnapshot.isError).toBe(true);expect(failedSnapshot.output).not.toContain('Field-rev5')
  expect((await skill.executeTool({id:'unavailable-search',name:'find_sensitive_info',input:{}})).isError).toBe(true)
 }finally{
  await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()
 }
})

for(const creation of [{name:'extract_pages',input:{pages:'2'},endpoint:'extract-pages',payload:{pages:[2]}},{name:'split_pages',input:{per_page:2},endpoint:'page-layout',payload:{operation:{kind:'split',perPage:2}}},{name:'merge_pages',input:{per_sheet:2},endpoint:'page-layout',payload:{operation:{kind:'merge',perSheet:2,direction:'vertical',separator:false}}}])test(`PDF ${creation.name} saves pending rotations and recovers the same created upload without changing source pages`,async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockResolvedValue({pages:[{page:1,width:500,height:600,text:'First source page'},{page:2,width:500,height:600,text:'Second source page'}],outline:[]})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const receipt={fileId:'created',revision:'created-rev',sha256:'a'.repeat(64),size:100}
 let revision='source-rev1',lost=true,guard:(()=>boolean|Promise<boolean>)|null=null
 const calls:Array<[string,string|undefined,unknown]>=[]
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,method,body])
  if(path.endsWith('/apply-ops/query'))return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0='}
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision},downloadEndpoint:`/api/v1/files/source/content?revision=${revision}`}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/pdf/apply-ops/uploads'))return {commitInput:{fileId:'source',uploadId:'rotation',baseRevision:revision,leaseEpoch:7,idempotencyKey:'key'}}
  if(path.endsWith('/commits')){revision='source-rev2';return {fileId:'source',revision}}
  if(path.endsWith(`/${creation.endpoint}/uploads`))return {uploadId:'extract',fileId:'created',sha256:receipt.sha256,size:receipt.size}
  if(path.endsWith('/finish')){if(lost){lost=false;throw Error('lost finish response')}return {format:'pdf',file:receipt}}
  if(path.includes('/revisions/'))return receipt
  return {}
 })
 const onCreatedPdf=vi.fn(async()=>{})
 document.body.innerHTML='<div id="pdf-extract-test"></div>'
 const root=createRoot(document.getElementById('pdf-extract-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'report.pdf',format:'pdf',request,assistantEnabled:true,onCreatedPdf,registerGuard:(_id,value)=>{guard=value}}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)?.[4]?.[0]
  expect(skill.tools.some((tool:{name:string})=>tool.name===creation.name)).toBe(true)
  const rotate=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='向右旋转 90°')!
  await act(async()=>rotate.click())
  await act(async()=>{expect((await skill.executeTool({id:'blocked-copy',name:creation.name,input:creation.input})).isError).toBe(true)})
  expect(calls.some(c=>c[0].endsWith('/commits'))).toBe(false)
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='保存新版本')!.click())
  await act(async()=>{const result=await skill.executeTool({id:'extract',name:creation.name,input:creation.input});expect(result.mutated).toBe(false);expect(result.isError).toBe(true)})
  const stage=calls.find(call=>call[0].endsWith(`/${creation.endpoint}/uploads`))
  expect(stage?.[2]).toMatchObject({baseRevision:'source-rev2',...creation.payload})
  expect(calls.findIndex(call=>call[0].endsWith('/commits'))).toBeLessThan(calls.findIndex(call=>call[0].endsWith(`/${creation.endpoint}/uploads`)))
  expect(onCreatedPdf).not.toHaveBeenCalled()
  await act(async()=>{expect(await guard?.()).toBe(false)})
  await act(async()=>{expect((await skill.executeTool({id:'retry-extract',name:creation.name,input:creation.input})).mutated).toBe(false)})
  expect(calls.filter(call=>call[0].endsWith(`/${creation.endpoint}/uploads`))).toHaveLength(1)
  const refreshedCreated=vi.fn(async(_receipt:unknown)=>{})
  await act(async()=>root.render(h(DocumentPreview,{fileId:'source',name:'report.pdf',format:'pdf',request,assistantEnabled:true,onCreatedPdf:refreshedCreated,registerGuard:(_id,value)=>{guard=value}})))
  expect(createEditorAssistant).toHaveBeenCalledTimes(1)
  const confirm=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='确认保存结果')!
  await act(async()=>confirm.click())
  expect(onCreatedPdf).not.toHaveBeenCalled()
  expect(refreshedCreated).toHaveBeenCalledExactlyOnceWith(receipt)
  expect(calls.filter(call=>call[0].endsWith('/finish')).map(call=>call[0])).toEqual(['/api/v1/uploads/extract/finish','/api/v1/uploads/extract/finish'])
  expect(await guard?.()).toBe(true)
  expect((await skill.executeTool({id:'read-source',name:'read_pages',input:{start:1,end:2}})).output).toContain('Second source page')
 }finally{
  await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()
 }
})

for(const failureKind of ['lost','auth-version','expired'])test(`PDF splitting saves rotations and recovers ${failureKind} second-file results without duplicating earlier files`,async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockResolvedValue({pages:[{page:1,width:500,height:600,text:'First source page'},{page:2,width:500,height:600,text:'Second source page'}],outline:[]})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const receipt={fileId:'created',revision:'created-rev',sha256:'a'.repeat(64),size:100}
 let revision='source-rev1',lost=true,guard:(()=>boolean|Promise<boolean>)|null=null
 const calls:Array<[string,string|undefined,unknown]>=[]
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,method,body])
  if(path.endsWith('/apply-ops/query'))return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0='}
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision},downloadEndpoint:`/api/v1/files/source/content?revision=${revision}`}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/pdf/apply-ops/uploads'))return {commitInput:{fileId:'source',uploadId:'rotation',baseRevision:revision,leaseEpoch:7,idempotencyKey:'key'}}
  if(path.endsWith('/commits')){revision='source-rev2';return {fileId:'source',revision}}
  if(path.endsWith('/split/uploads'))return {files:[{uploadId:'extract',fileId:'created',sha256:receipt.sha256,size:receipt.size},{uploadId:'split-2',fileId:'created-2',sha256:receipt.sha256,size:receipt.size}]}
  if(path.endsWith('/finish')){if(path.includes('split-2')&&lost){lost=false;throw failureKind==='expired'?Object.assign(Error('upload expired before publication'),{status:410}):failureKind==='auth-version'?Object.assign(Error('auth version changed after publication'),{status:409}):Error('lost finish response')}return {format:'pdf',file:path.includes('split-2')?{...receipt,fileId:'created-2'}:receipt}}
  if(path.includes('/revisions/'))return path.includes('created-2')?{...receipt,fileId:'created-2'}:receipt
  return {}
 })
 const onCreatedPdf=vi.fn(async()=>{})
 document.body.innerHTML='<div id="pdf-extract-test"></div>'
 const root=createRoot(document.getElementById('pdf-extract-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'report.pdf',format:'pdf',request,assistantEnabled:true,onCreatedPdf,registerGuard:(_id,value)=>{guard=value}}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)?.[4]?.[0]
  expect(skill.tools.some((tool:{name:string})=>tool.name==='split_pdf')).toBe(true)
  const rotate=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='向右旋转 90°')!
  await act(async()=>rotate.click())
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='保存新版本')!.click())
  await act(async()=>{const result=await skill.executeTool({id:'extract',name:'split_pdf',input:{pages_per_file:1}});expect(result.mutated).toBe(false);expect(result.isError).toBe(true)})
  expect(document.body.textContent).toContain('已确认生成 1/2 份 PDF')
  const stage=calls.find(call=>call[0].endsWith('/split/uploads'))
  expect(stage?.[2]).toMatchObject({baseRevision:'source-rev2',pagesPerFile:1})
  expect(calls.findIndex(call=>call[0].endsWith('/commits'))).toBeLessThan(calls.findIndex(call=>call[0].endsWith('/split/uploads')))
  expect(onCreatedPdf).toHaveBeenCalledExactlyOnceWith(receipt)
  await act(async()=>{expect(await guard?.()).toBe(false)})
  await act(async()=>{expect((await skill.executeTool({id:'retry-extract',name:'split_pdf',input:{pages_per_file:1}})).mutated).toBe(false)})
  expect(calls.filter(call=>call[0].endsWith('/split/uploads'))).toHaveLength(1)
  const refreshedCreated=vi.fn(async(_receipt:unknown)=>{})
  await act(async()=>root.render(h(DocumentPreview,{fileId:'source',name:'report.pdf',format:'pdf',request,assistantEnabled:true,onCreatedPdf:refreshedCreated,registerGuard:(_id,value)=>{guard=value}})))
  expect(createEditorAssistant).toHaveBeenCalledTimes(1)
  const confirm=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='确认保存结果')!
  await act(async()=>confirm.click())
  expect(onCreatedPdf).toHaveBeenCalledExactlyOnceWith(receipt)
  expect(refreshedCreated.mock.calls.map(call=>call[0])).toEqual(failureKind==='expired'?[]:[{...receipt,fileId:'created-2'}])
  expect(document.body.textContent).toContain(failureKind==='expired'?'仅生成 1/2 份 PDF':'已生成并打开 2/2 份 PDF')
  expect(document.body.textContent).not.toContain('版本或租约发生冲突')
  expect(calls.filter(call=>call[0].endsWith('/finish')).map(call=>call[0])).toEqual(failureKind==='expired'?['/api/v1/uploads/extract/finish','/api/v1/uploads/split-2/finish']:['/api/v1/uploads/extract/finish','/api/v1/uploads/split-2/finish','/api/v1/uploads/split-2/finish'])
  expect(await guard?.()).toBe(true)
  expect((await skill.executeTool({id:'read-source',name:'read_pages',input:{start:1,end:2}})).output).toContain('Second source page')
 }finally{
  await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()
 }
})

test('PDF form fills save one revision and reload fields and appearances from the exact recovered commit',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 let published=false,lost=true,releaseRefresh!:()=>void
 const refresh=new Promise<void>(resolve=>{releaseRefresh=resolve})
 mountPdfEditor.mockImplementation(async()=>{if(published)await refresh;return {pages:[{page:1,width:500,height:600,text:'Application form'}],outline:[],formFields:[{name:'Customer',kind:'text',pageIndex:0,value:published?'Alice':'',checked:false,required:false,readOnly:false,options:[]}]}})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const calls:Array<[string,string|undefined,unknown]>=[]
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,method,body])
  if(path.endsWith('/apply-ops/query'))return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0='}
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/apply-ops/uploads'))return {commitInput:{fileId:'source',uploadId:'forms',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:'form-key'}}
  if(path.endsWith('/commits')){published=true;if(lost){lost=false;throw Error('lost response')}return {fileId:'source',revision:'rev2'}}
  return {}
 })
 document.body.innerHTML='<div id="pdf-form-fill-test"></div>'
 const root=createRoot(document.getElementById('pdf-form-fill-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'form.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)?.[4]?.[0]
  const ops=[{op:'setFormValue',value:{name:'Customer',value:'Alice'}}]
  expect(skill.tools.find((tool:{name:string})=>tool.name==='apply_ops').description).toContain('setFormValue')
  const before=calls.length
  await act(async()=>{expect((await skill.executeTool({id:'dry',name:'apply_ops',input:{ops,dry_run:true}})).mutated).toBe(false)})
  expect(calls).toHaveLength(before)
  await act(async()=>{const result=await skill.executeTool({id:'fill',name:'apply_ops',input:{ops}});expect(result.isError).not.toBe(true);expect(result.mutated).toBe(true)})
  expect(calls.filter(call=>call[0].endsWith('/apply-ops/uploads'))).toHaveLength(0)
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='保存新版本')!.click())
  expect(calls.filter(call=>call[0].endsWith('/apply-ops/uploads'))).toHaveLength(1)
  expect(calls.find(call=>call[0].endsWith('/apply-ops/uploads'))?.[2]).toMatchObject({baseRevision:'rev1',snapshot:{formEdits:{Customer:{name:'Customer',value:'Alice'}}}})
  const confirm=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='确认保存结果')!
  await act(async()=>confirm.click())
  expect(mountPdfEditor).toHaveBeenCalledTimes(3)
  expect(document.body.contains(confirm)).toBe(true)
  expect(confirm.disabled).toBe(true)
  await act(async()=>releaseRefresh())
  const commits=calls.filter(call=>call[0].endsWith('/commits'))
  expect(commits).toHaveLength(2);expect(commits[0][2]).toEqual(commits[1][2])
  expect(vi.mocked(fetch).mock.calls.map(call=>call[0])).toContain('/api/v1/files/source/content?revision=rev2')
  expect(mountPdfEditor).toHaveBeenCalledTimes(3)
  expect((await skill.executeTool({id:'saved-fields',name:'list_form_fields',input:{}})).output).toContain('Alice')
 }finally{
  await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()
 }
})

test.each([
 ['move_text_block','block-moves',{page:1,paragraph_text:'Name:',dx:20,dy:-10}],
 ['edit_block','block-edits',{page:1,paragraph_text:'Name:',new_text:'Changed paragraph',align:'right'}],
] as const)('PDF %s uses the revision writer and reloads the saved page',async(tool,action,input)=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockResolvedValue({pages:[{page:1,width:500,height:600,text:'Name:'}],outline:[],formFields:[]})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const calls:Array<[string,unknown]>=[]
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,body])
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/'+action+'/uploads'))return {commitInput:{fileId:'source',uploadId:'insert',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:'insert-key'}}
  if(path.endsWith('/commits'))return {fileId:'source',revision:'rev2'}
  return {}
 })
 document.body.innerHTML='<div id="pdf-insert-test"></div>'
 const root=createRoot(document.getElementById('pdf-insert-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'insert.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)?.[4]?.[0]
  await act(async()=>{expect((await skill.executeTool({id:'insert',name:tool,input})).mutated).toBe(true)})
  expect(calls.find(call=>call[0].endsWith('/'+action+'/uploads'))?.[1]).toMatchObject({baseRevision:'rev1',operations:[input]})
  expect(calls.filter(call=>call[0].endsWith('/commits'))).toHaveLength(1)
  expect(vi.mocked(fetch).mock.calls.map(call=>call[0])).toContain('/api/v1/files/source/content?revision=rev2')
  expect(mountPdfEditor).toHaveBeenCalledTimes(2)
 }finally{
  await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()
 }
})

test.each(['ready','error'])('PDF loading covers pending page rendering until %s',async outcome=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 let complete!:(value:unknown)=>void,fail!:(error:Error)=>void
 mountPdfEditor.mockImplementationOnce(()=>new Promise((resolve,reject)=>{complete=resolve;fail=reject}))
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(new Uint8Array([1])))
 const container=document.createElement('div');document.body.append(container)
 const root=createRoot(container)
 const request=vi.fn().mockResolvedValue({file:{fileId:'loading',revision:'r1'},downloadEndpoint:'/api/v1/files/loading/content?revision=r1'})
 try{
  await act(async()=>root.render(h(DocumentPreview,{fileId:'loading',name:'Loading.pdf',format:'pdf',request})))
  await vi.waitFor(()=>expect(complete).toBeTypeOf('function'))
  expect(container.querySelector('.document-loading')?.textContent).toContain('正在准备页面')
  expect(container.querySelector('.document-loading-content')?.getAttribute('data-loading')).toBe('true')
  await act(async()=>{if(outcome==='error')fail(Error('render failed'));else complete({pages:[{page:1,width:10,height:10,text:'Content',annotations:[]}],outline:[],formFields:[]})})
  expect(container.querySelector('.document-loading')).toBeNull()
  expect(container.querySelector('.document-loading-content')?.getAttribute('data-loading')).toBe('false')
  if(outcome==='error')expect(container.textContent).toContain('无法生成只读预览')
  else expect(container.querySelector('[aria-label="PDF 导航"]')).not.toBeNull()
 }finally{await act(async()=>root.unmount());container.remove();fetch.mockRestore();mountPdfEditor.mockReset();vi.unstubAllGlobals()}
})

test('PDF existing images stay unsaved and undoable until user Save, with claimed targets and stale listings rejected',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"><canvas/></div></figure>';return {pages:[{page:1,text:'Picture caption',width:500,height:600}],outline:[],formFields:[]}})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 let holdQuery=false,releaseQuery:(()=>void)|undefined
 const calls:Array<[string,unknown]>=[]
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,body])
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/images/query'))return {revision:(body as {revision:string}).revision,images:[{page:1,image_number:1,x:20,y:30,width:100,height:50,layer:'below_text'}]}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/apply-ops/query')){if(holdQuery)await new Promise<void>(resolve=>releaseQuery=resolve);return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0x'}}
  if(path.endsWith('/apply-ops/uploads'))return {commitInput:{fileId:'source',uploadId:'image',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:'image-key'}}
  if(path.endsWith('/commits'))return {fileId:'source',revision:'rev2'}
  return {}
 })
 document.body.innerHTML='<div id="pdf-image-test"></div>'
 const root=createRoot(document.getElementById('pdf-image-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'image.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)?.[4]?.[0],input={page:1,image_number:1,direction:'cw'}
  await act(async()=>{expect((await skill.executeTool({id:'unlisted',name:'rotate_image',input})).isError).toBe(true)})
  expect(calls.some(call=>call[0].endsWith('/image-edits/uploads'))).toBe(false)
  await act(async()=>{await skill.executeTool({id:'read',name:'list_page_images',input:{}})})
  holdQuery=true;let pending:Promise<any>
  await act(async()=>{pending=skill.executeTool({id:'rotate',name:'rotate_image',input})})
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='保存新版本')!.disabled).toBe(true)
  await act(async()=>{expect((await skill.executeTool({id:'concurrent-text',name:'insert_text',input:{page:1,text:'Concurrent'}})).isError).toBe(true)})
  holdQuery=false;await act(async()=>{releaseQuery!();expect((await pending!).mutated).toBe(true)})
  expect(calls.some(call=>call[0].includes('/uploads')||call[0].endsWith('/lease'))).toBe(false)
  expect(document.querySelector('[aria-label="已有图片待保存编辑"]')).not.toBeNull()
  const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===name)!
  expect(button('向右旋转 90°').disabled).toBe(false)
  expect(skill.tools.some((tool:{name:string})=>tool.name==='rotate_pages')).toBe(false)
  await act(async()=>{expect((await skill.executeTool({id:'blocked-rotation',name:'apply_ops',input:{ops:[{op:'rotatePages',pages:[1],dir:90}]}})).mutated).toBe(true)})
  await act(async()=>button('撤销修改').click());expect(document.querySelector('[aria-label="已有图片待保存编辑"]')).not.toBeNull()
  await act(async()=>button('撤销修改').click());expect(document.querySelector('[aria-label="已有图片待保存编辑"]')).toBeNull()
  await act(async()=>{await skill.executeTool({id:'read-again',name:'list_page_images',input:{}});await skill.executeTool({id:'rotate-again',name:'rotate_image',input})})
  await act(async()=>{expect((await skill.executeTool({id:'stale',name:'rotate_image',input})).isError).toBe(true)})
  await act(async()=>button('保存新版本').click())
  expect(calls.filter(call=>call[0].endsWith('/apply-ops/uploads'))).toHaveLength(1)
  expect(calls.find(call=>call[0].endsWith('/apply-ops/uploads'))?.[1]).toMatchObject({baseRevision:'rev1',snapshot:{savedImageEdits:[{op:'rotate_image',...input}]}})
  await act(async()=>{await skill.executeTool({id:'fresh',name:'list_page_images',input:{}})})
  expect(calls.filter(call=>call[0].endsWith('/images/query')).at(-1)?.[1]).toEqual({revision:'rev2'})
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('PDF saved image replacement queues media bytes and saves only after user confirmation',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"><canvas/></div></figure>';return {pages:[{page:1,text:'Picture caption',width:500,height:600}],outline:[],formFields:[]}})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const calls:Array<[string,unknown]>=[],image={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,body])
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path==='/api/v1/ai/media')return image
  if(path.endsWith('/images/query'))return {revision:'rev1',images:[{page:1,image_number:1,x:10,y:20,width:80,height:40,layer:'below_text'}]}
  if(path.endsWith('/apply-ops/query'))return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0x'}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/apply-ops/uploads'))return {commitInput:{fileId:'source',uploadId:'image',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:'image-key'}}
  if(path.endsWith('/commits'))return {fileId:'source',revision:'rev2'}
  return {}
 })
 document.body.innerHTML='<div id="pdf-image-content-test"></div>'
 const root=createRoot(document.getElementById('pdf-image-content-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'image.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)?.[4]?.[0]
  expect(skill.tools.map((tool:{name:string})=>tool.name)).toContain('replace_image')
  await act(async()=>{await skill.executeTool({id:'list',name:'list_page_images',input:{page:1}});expect((await skill.executeTool({id:'replace',name:'replace_image',input:{page:1,image_number:1,url:'https://images.example/a.png'}})).mutated).toBe(true)})
  expect(calls.find(call=>call[0]==='/api/v1/ai/media')?.[1]).toEqual({action:'fetch_image',url:'https://images.example/a.png'})
  expect(calls.some(call=>call[0].includes('/uploads'))).toBe(false)
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='保存新版本')!.click())
  expect(calls.find(call=>call[0].endsWith('/apply-ops/uploads'))?.[1]).toMatchObject({baseRevision:'rev1',snapshot:{savedImageEdits:[{op:'replace_image',page:1,image_number:1,image}]}})
  expect(document.body.textContent).toContain('PDF 修改已保存为新版本')
  expect(document.querySelector('[aria-label="已有图片待保存编辑"]')).toBeNull()
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('PDF pixel tools queue native previews and save only through the shared draft batch',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"><canvas/></div></figure>';return {pages:[{page:1,text:'Picture caption',width:500,height:600}],outline:[],formFields:[]}})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 let savedRevision=1
 const calls:Array<[string,unknown]>=[]
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,body])
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev'+savedRevision},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/images/query'))return {revision:(body as {revision:string}).revision,images:[{page:1,image_number:1,x:20,y:30,width:100,height:50,layer:'below_text'}]}
  if(path.endsWith('/apply-ops/query'))return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0x'}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/apply-ops/uploads'))return {commitInput:{fileId:'source',uploadId:'image',baseRevision:(body as {baseRevision:string}).baseRevision,leaseEpoch:7,idempotencyKey:'image-key'+savedRevision}}
  if(path.endsWith('/commits'))return {fileId:'source',revision:'rev'+(++savedRevision)}
  return {}
 })
 document.body.innerHTML='<div id="pdf-image-test"></div>'
 const root=createRoot(document.getElementById('pdf-image-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'image.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)?.[4]?.[0]
  const operations=[{op:'flip_image',page:1,image_number:1,axis:'horizontal'},{op:'set_image_opacity',page:1,image_number:1,opacity:.4},{op:'crop_image',page:1,image_number:1,left:.25},{op:'remove_image_background',page:1,image_number:1,tolerance:20}]
  for(const operation of operations){
   const {op,...input}=operation
   await act(async()=>{expect((await skill.executeTool({id:'unlisted',name:op,input})).isError).toBe(true)})
   await act(async()=>{await skill.executeTool({id:'read',name:'list_page_images',input:{}})})
   await act(async()=>{expect((await skill.executeTool({id:'edit',name:op,input})).mutated).toBe(true)})
   expect(calls.filter(call=>call[0].endsWith('/apply-ops/uploads'))).toHaveLength(savedRevision-1)
   await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='保存新版本')!.click())
   expect(calls.filter(call=>call[0].endsWith('/apply-ops/uploads')).at(-1)?.[1]).toMatchObject({baseRevision:'rev'+(savedRevision-1),snapshot:{savedImageEdits:[operation]}})
   await act(async()=>{expect((await skill.executeTool({id:'stale',name:op,input})).isError).toBe(true)})
  }
  expect(calls.filter(call=>call[0].endsWith('/apply-ops/uploads'))).toHaveLength(4)
  expect(calls.some(call=>call[0].endsWith('/image-edits/uploads'))).toBe(false)
  expect(document.querySelector('[aria-label="已有图片待保存编辑"]')).toBeNull()
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('PDF managed stamps reach the actual assistant inventory and save one configuration against each current revision',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockResolvedValue({pages:[{page:1,width:500,height:600,text:'Original content'}],outline:[],formFields:[]})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const calls:Array<[string,unknown]>=[];let savedRevision=1
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,body])
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/stamps/uploads'))return {commitInput:{fileId:'source',uploadId:'stamps',baseRevision:'rev'+savedRevision,leaseEpoch:7,idempotencyKey:'stamp-key-'+savedRevision}}
  if(path.endsWith('/commits'))return {fileId:'source',revision:'rev'+(++savedRevision)}
  return {}
 })
 document.body.innerHTML='<div id="pdf-stamp-test"></div>'
 const root=createRoot(document.getElementById('pdf-stamp-test')!)
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'stamp.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const args=createEditorAssistant.mock.calls.at(-1)!,skill=args[4][0]
  expect(args[3].has('set_watermark')).toBe(true);expect(args[3].has('set_header_footer')).toBe(true)
  const inputs=[{op:'set_watermark',text:'CONFIDENTIAL'},{op:'set_header_footer',header_left:'Project',page_number:true},{op:'set_watermark',text:''},{op:'set_header_footer'}]
  for(const operation of inputs){
   const {op,...input}=operation
   await act(async()=>{expect((await skill.executeTool({id:'stamp',name:op,input})).mutated).toBe(true)})
   expect(calls.filter(call=>call[0].endsWith('/stamps/uploads')).at(-1)?.[1]).toMatchObject({baseRevision:'rev'+(savedRevision-1),operation})
  }
  expect(calls.filter(call=>call[0].endsWith('/stamps/uploads'))).toHaveLength(4)
  expect(mountPdfEditor).toHaveBeenCalledTimes(5)
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('PDF replacement waits for source confirmation, cancels cleanly and uploads only the selected file',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockResolvedValue({pages:[{page:1,width:500,height:600,text:'First'},{page:2,width:500,height:600,text:'Second'},{page:3,width:500,height:600,text:'Third'}],outline:[],formFields:[]})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const calls:Array<[string,unknown]>=[]
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,body])
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.includes('/replace-pages/uploads?'))return {commitInput:{fileId:'source',uploadId:'replaced',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:'replacement-key'}}
  if(path.endsWith('/commits'))return {fileId:'source',revision:'rev2'}
  return {}
 })
 document.body.innerHTML='<div id="pdf-replace-test"></div>';const root=createRoot(document.getElementById('pdf-replace-test')!)
 const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'target.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const args=createEditorAssistant.mock.calls.at(-1)!,skill=args[4][0];expect(args[3].has('replace_pages')).toBe(true)
  let pending:Promise<any>
  await act(async()=>{pending=skill.executeTool({id:'cancel',name:'replace_pages',input:{pages:[1,3]}})})
  expect(document.body.textContent).toContain('替换第 1、3 页');expect(button('确认替换并保存').disabled).toBe(true)
  expect(calls.filter(([path])=>path.includes('/lease')||path.includes('/uploads'))).toHaveLength(0)
  await act(async()=>button('取消替换').click());expect((await pending!).mutated).toBe(false)
  const controller=new AbortController()
  await act(async()=>{pending=skill.executeTool({id:'abort',name:'replace_pages',input:{pages:[2]}},controller.signal)})
  await act(async()=>controller.abort());expect((await pending!).mutated).toBe(false)
  expect(document.querySelector('[aria-label="替换 PDF 页面"]')).toBeNull()
  await act(async()=>{pending=skill.executeTool({id:'save',name:'replace_pages',input:{pages:[1,3]}})})
  const selected=new File(['%PDF-selected'],'source.pdf',{type:'application/pdf'})
  const input=document.querySelector<HTMLInputElement>('[aria-label="选择替换来源 PDF"]')!
  Object.defineProperty(input,'files',{value:[selected],configurable:true})
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})))
  expect(button('确认替换并保存').disabled).toBe(false)
  await act(async()=>{button('确认替换并保存').click();await pending!})
  expect((await pending!).mutated).toBe(true)
  const stages=calls.filter(([path])=>path.includes('/replace-pages/uploads?'));expect(stages).toHaveLength(1);expect(stages[0][1]).toBe(selected)
  expect(JSON.parse(new URL(stages[0][0],'http://test').searchParams.get('pages')!)).toEqual([1,3])
  expect(mountPdfEditor).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[aria-label="替换 PDF 页面"]')).toBeNull()
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('PDF sensitive marks require user review and explicit copy confirmation without mutating the original',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"><canvas/></div></figure>';return {pages:[{page:1,text:'one@example.com two@example.com',width:400,height:500}],outline:[],formFields:[]}})
 const bytes=new Uint8Array([37,80,68,70,45,49])
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let read=false;return {async read(){if(read)return {done:true};read=true;return {done:false,value:bytes}}}}}})))
 const calls:Array<[string,unknown]>=[],sha256='a'.repeat(64),receipt={fileId:'copy',revision:'copy-revision',sha256,size:20},onCreatedPdf=vi.fn(async()=>{})
 const candidates=['one@example.com','two@example.com'].map((text,index)=>({id:'candidate-'+index,page:1,text,rect:[10,20,80,30],displayRect:{left:10,top:20+index*20,width:70,height:10}}))
 let holdQuery=false,releaseQuery:(()=>void)|undefined
 const request=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push([path,body])
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/redactions/query')){if(holdQuery)await new Promise<void>(resolve=>{releaseQuery=resolve});return {revision:'rev1',candidates,truncated:false,scannedPages:[1],unsupportedPages:[]}}
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/redacted-copy/uploads'))return {uploadId:'redacted-upload',fileId:'copy',sha256,size:20}
  if(path.endsWith('/finish'))return {format:'pdf',file:receipt}
  if(path.includes('/revisions/'))return receipt
  return {}
 })
 document.body.innerHTML='<div id="pdf-redact-test"></div>';const root=createRoot(document.getElementById('pdf-redact-test')!)
 const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'source.pdf',format:'pdf',request,assistantEnabled:true,onCreatedPdf}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)![4][0]
  holdQuery=true;let lateMark:Promise<any>,replacement:Promise<any>
  await act(async()=>{lateMark=skill.executeTool({id:'slow-mark',name:'find_sensitive_info',input:{patterns:['email'],mark:true}})})
  await act(async()=>{replacement=skill.executeTool({id:'replace',name:'replace_pages',input:{pages:[1]}})})
  await act(async()=>{releaseQuery!();await lateMark!})
  expect((await lateMark!).isError).toBe(true)
  expect(document.querySelector('[aria-label="涂黑候选审查"]')).toBeNull()
  expect(document.querySelector('[aria-label="替换 PDF 页面"]')).not.toBeNull()
  await act(async()=>button('取消替换').click());expect((await replacement!).mutated).toBe(false);holdQuery=false
  await act(async()=>{expect((await skill.executeTool({id:'mark',name:'find_sensitive_info',input:{patterns:['email'],mark:true}})).mutated).toBe(false)})
  expect(document.querySelector('[aria-label="涂黑候选审查"]')).not.toBeNull();expect(document.querySelectorAll('svg[aria-label="待确认的涂黑标记"] rect')).toHaveLength(2)
  expect(calls.filter(([path])=>path.includes('/uploads')||path.includes('/lease'))).toHaveLength(0)
  await act(async()=>{expect((await skill.executeTool({id:'edit',name:'set_watermark',input:{text:'Draft'}})).isError).toBe(true)})
  expect(calls.some(([path])=>path.endsWith('/stamps/uploads'))).toBe(false)
  const checkboxes=document.querySelectorAll<HTMLInputElement>('[aria-label="涂黑候选审查"] input[type="checkbox"]')
  await act(async()=>checkboxes[1].click());expect(document.querySelectorAll('svg[aria-label="待确认的涂黑标记"] rect')).toHaveLength(1)
  await act(async()=>button('生成涂黑副本').click())
  expect(calls.some(([path])=>path.endsWith('/redacted-copy/uploads'))).toBe(false)
  await act(async()=>{button('确认永久涂黑并另存').click();await new Promise(resolve=>setTimeout(resolve,0))})
  expect(calls.find(([path])=>path.endsWith('/redacted-copy/uploads'))?.[1]).toMatchObject({baseRevision:'rev1',patterns:['email'],ids:['candidate-0']})
  expect(calls.some(([path])=>path.endsWith('/commits'))).toBe(false);expect(onCreatedPdf).toHaveBeenCalledWith(receipt)
  expect(document.querySelector('[aria-label="涂黑候选审查"]')).toBeNull();expect(document.querySelector('svg[aria-label="待确认的涂黑标记"]')).toBeNull()
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('discard invalidates late snapshot preview and keeps the saved baseline',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"></div></figure>';return {pages:[{page:1,text:'Original',width:400,height:500}],outline:[],formFields:[],pageGeometries:[{pw:400,ph:500,rot:0}]}})
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([37,80,68,70]))))
 let release!:(value:any)=>void,queryBody:any
 const request=vi.fn(async(path:string,_method?:string,body?:any)=>{
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/apply-ops/query')){queryBody=body;return new Promise(resolve=>{release=resolve})}
  return {}
 })
 document.body.innerHTML='<div id="pdf-render-test"></div>';const root=createRoot(document.getElementById('pdf-render-test')!)
 const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'source.pdf',format:'pdf',request}));await new Promise(resolve=>setTimeout(resolve,0))})
  await act(async()=>button('向右旋转 90°').click())
  expect(button('保存新版本').disabled).toBe(true)
  await act(async()=>button('放弃修改').click())
  await act(async()=>release({revision:'rev1',generation:queryBody.snapshot.generation,pdf:'JVBERi0='}))
  expect(mountPdfEditor).toHaveBeenCalledTimes(1)
  expect(button('保存新版本').disabled).toBe(true)
  expect(request.mock.calls.some(call=>call[0].endsWith('/uploads'))).toBe(false)
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})

test('canceling form-mark planning cannot append a draft after the PDF viewer closes',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"><canvas></canvas></div></figure>';return {pages:[{page:1,text:'Consent',width:500,height:600}],outline:[],formFields:[]}})
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([37,80,68,70]))))
 let release!:(value:any)=>void
 preparePdfFormMark.mockReturnValue(new Promise(resolve=>{release=resolve}))
 const request=vi.fn(async(path:string)=>path==='/api/v1/files/mark-close'?{file:{fileId:'mark-close',revision:'r1'},downloadEndpoint:'/api/v1/files/mark-close/content?revision=r1'}:{})
 const target=document.createElement('div');document.body.append(target);const root=createRoot(target),abort=new AbortController()
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'mark-close',name:'Form.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)![4][0]
  let pending!:Promise<any>
  await act(async()=>{pending=skill.executeTool({id:'mark',name:'add_form_mark',input:{page:1,kind:'check',x:10,y:20}},abort.signal);await Promise.resolve()})
  await vi.waitFor(()=>expect(preparePdfFormMark).toHaveBeenCalled())
  abort.abort();await act(async()=>root.unmount())
  release({kind:'image',x:10,y:20,width:12,height:12,image:{mime:'image/png',base64:'unused'}})
  await expect(pending).rejects.toMatchObject({name:'AbortError'})
  expect(request.mock.calls.some(([path])=>String(path).endsWith('/image-inserts/query'))).toBe(false)
 }finally{target.remove();createEditorAssistant.mockReset();mountPdfEditor.mockReset();preparePdfFormMark.mockReset()}
})


test('canonical toolbar and assistant edits share global undo redo and one explicit snapshot save',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"></div></figure>';return {pages:[{page:1,text:'Original',width:500,height:600}],outline:[],formFields:[],pageGeometries:[{pw:500,ph:600,rot:0,x0:0,y0:0,userUnit:1}]}})
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([37,80,68,70]))))
 const calls:Array<{path:string;body:any}>=[]
 const request=vi.fn(async(path:string,_method?:string,body?:any)=>{
  calls.push({path,body})
  if(path.endsWith('/apply-ops/query'))return {revision:(body as any).revision,generation:(body as any).snapshot.generation,pdf:'JVBERi0='}
  if(path==='/api/v1/files/canonical')return {file:{fileId:'canonical',revision:'r1'},downloadEndpoint:'/api/v1/files/canonical/content?revision=r1'}
  if(path.endsWith('/apply-ops/query'))return {revision:body.revision,generation:body.snapshot.generation,pdf:'JVBERi0='}
  if(path.endsWith('/lease'))return {leaseEpoch:1}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'canonical',uploadId:'one',baseRevision:'r1',leaseEpoch:1,idempotencyKey:'one'}}
  if(path.endsWith('/commits'))return {fileId:'canonical',revision:'r2'}
  return {}
 })
 document.body.innerHTML='<div id="canonical-pdf"></div>';const root=createRoot(document.getElementById('canonical-pdf')!)
 const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===name)!
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'canonical',name:'Canonical.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  await act(async()=>button('向右旋转 90°').click())
  const skill=createEditorAssistant.mock.calls.at(-1)![4][0]
  await act(async()=>{const r=await skill.executeTool({id:'canonical',name:'apply_ops',input:{ops:[{op:'setMetadata',metadata:{title:'Unified'}}]}});expect(r.isError).not.toBe(true)})
  expect(calls.filter(c=>c.path.endsWith('/uploads'))).toHaveLength(0)
  await act(async()=>button('撤销修改').click());await act(async()=>button('重做修改').click())
  await act(async()=>button('保存新版本').click())
  const uploads=calls.filter(c=>c.path.endsWith('/uploads'));expect(uploads).toHaveLength(1)
  expect(uploads[0].path).toContain('/apply-ops/uploads');expect(uploads[0].body.snapshot.rotations).toEqual({0:90});expect(uploads[0].body.snapshot.metadata).toEqual({title:'Unified'})
  expect(calls.filter(c=>c.path.endsWith('/commits'))).toHaveLength(1)
  expect(button('保存新版本').disabled).toBe(true)
 }finally{await act(async()=>root.unmount());document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})


test('discard during temporary PDF mount restores baseline before the abandoned render finishes',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 let release!:()=>void,temporarySignal:AbortSignal|undefined
 mountPdfEditor.mockImplementation(async(host:HTMLElement,_bytes:Uint8Array,signal:AbortSignal)=>{
  const n=mountPdfEditor.mock.calls.length
  host.textContent=n===2?'Abandoned temporary':'Original baseline'
  if(n===2){temporarySignal=signal;await new Promise<void>(resolve=>{release=resolve});signal.throwIfAborted()}
  return {pages:[{page:1,text:'Original',width:400,height:500}],outline:[],formFields:[],pageGeometries:[{pw:400,ph:500,rot:0}]}
 })
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([37,80,68,70]))))
 const request=vi.fn(async(path:string,_method?:string,body?:any)=>{
  if(path==='/api/v1/files/source')return {file:{fileId:'source',revision:'rev1'},downloadEndpoint:'/api/v1/files/source/content?revision=rev1'}
  if(path.endsWith('/apply-ops/query'))return {revision:'rev1',generation:body.snapshot.generation,pdf:'JVBERi0='}
  return {}
 })
 document.body.innerHTML='<div id="mid-render"></div>';const root=createRoot(document.getElementById('mid-render')!)
 const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'source',name:'source.pdf',format:'pdf',request}));await new Promise(resolve=>setTimeout(resolve,0))})
  await act(async()=>button('向右旋转 90°').click())
  expect(document.querySelector('[aria-label="PDF 页面"]')!.textContent).toBe('Abandoned temporary')
  await act(async()=>button('放弃修改').click())
  expect(temporarySignal?.aborted).toBe(true)
  expect(document.querySelector('[aria-label="PDF 页面"]')!.textContent).toBe('Original baseline')
  await act(async()=>release())
  expect(document.querySelector('[aria-label="PDF 页面"]')!.textContent).toBe('Original baseline')
 }finally{release?.();await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})


test('pending P note mixed batch is saved once and confirmed reload failure cannot resave it',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);createEditorAssistant.mockResolvedValue({available:true,dispose:vi.fn()})
 let published=false,lost=true
 mountPdfEditor.mockImplementation(async(host:HTMLElement)=>{host.innerHTML='<figure data-pdf-page="1"><div class="pdf-page-surface"></div></figure>';return {pages:[{page:1,text:'Original',width:500,height:600}],outline:[],formFields:[{name:'Customer',kind:'text',pageIndex:0,value:'Saved',readOnly:false,required:false,checked:false,options:[]}],pageGeometries:[{pw:500,ph:600,rot:0}]}})
 vi.stubGlobal('fetch',vi.fn(async()=>{if(published)throw Error('reload failed');return new Response(new Uint8Array([37,80,68,70]))}))
 const calls:Array<{path:string;body:any}>=[]
 const request=vi.fn(async(path:string,_method?:string,body?:any)=>{
  calls.push({path,body})
  if(path==='/api/v1/files/notes')return {file:{fileId:'notes',revision:'r1'},downloadEndpoint:'/api/v1/files/notes/content?revision=r1'}
  if(path.endsWith('/annotations/query'))return {revision:'r1',markups:[],notes:[{kind:'note',pageIndex:0,at:[50,500],color:[1,1,0],contents:body.operations[0].contents}]}
  if(path.endsWith('/apply-ops/query'))return {revision:'r1',generation:body.snapshot.generation,pdf:'JVBERi0='}
  if(path.endsWith('/lease'))return {leaseEpoch:1}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'notes',uploadId:'one',baseRevision:'r1',leaseEpoch:1,idempotencyKey:'one'}}
  if(path.endsWith('/commits')){published=true;if(lost){lost=false;throw Error('lost receipt')}return {fileId:'notes',revision:'r2'}}
  return {}
 })
 document.body.innerHTML='<div id="notes-pdf"></div>';const root=createRoot(document.getElementById('notes-pdf')!)
 const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===name)!
 try{
  await act(async()=>{root.render(h(DocumentPreview,{fileId:'notes',name:'Notes.pdf',format:'pdf',request,assistantEnabled:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  const skill=createEditorAssistant.mock.calls.at(-1)![4][0]
  await act(async()=>{expect((await skill.executeTool({id:'note',name:'add_note',input:{page:1,anchor_text:'Original',contents:'Initial'}})).isError).not.toBe(true)})
  const annotations=await skill.executeTool({id:'read',name:'read_annotations',input:{}}),id=annotations.output.match(/P[0-9a-f-]{36}/)![0]
  await act(async()=>{expect((await skill.executeTool({id:'mixed',name:'apply_ops',input:{ops:[{op:'setNoteContents',id,contents:'Updated'},{op:'setFormValue',value:{name:'Customer',value:'Pending'}},{op:'setMetadata',metadata:{title:'Mixed'}}]}})).isError).not.toBe(true)})
  expect((await skill.executeTool({id:'fields',name:'list_form_fields',input:{}})).output).toContain('Pending')
  await act(async()=>{expect((await skill.executeTool({id:'unsafe',name:'edit_text',input:{page:1,old_text:'Original',new_text:'Wrong'}})).isError).toBe(true)})
  expect(calls.some(c=>c.path.endsWith('/uploads'))).toBe(false)
  await act(async()=>button('保存新版本').click())
  expect(button('保存新版本').disabled).toBe(true)
  await act(async()=>button('确认保存结果').click())
  expect(document.body.textContent).toContain('已保存，但预览刷新失败')
  expect(button('保存新版本').disabled).toBe(true)
  expect(calls.filter(c=>c.path.endsWith('/apply-ops/uploads'))).toHaveLength(1)
  const commits=calls.filter(c=>c.path.endsWith('/commits'));expect(commits).toHaveLength(2);expect(commits[0].body).toEqual(commits[1].body)
  expect(calls.find(c=>c.path.endsWith('/apply-ops/uploads'))!.body.snapshot.notes[0].input.contents).toBe('Updated')
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();document.body.innerHTML='';createEditorAssistant.mockReset();mountPdfEditor.mockReset()}
})
