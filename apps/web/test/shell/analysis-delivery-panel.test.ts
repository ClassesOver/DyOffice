import {expect,test,vi,afterEach} from 'vitest'
import {createElement as h,act} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {createRoot} from 'react-dom/client'
import {AnalysisDeliveryPanel} from '../../src/editors/analysis-delivery-panel'
const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL
afterEach(()=>{vi.restoreAllMocks();URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke})
function spyDownload(){URL.createObjectURL=vi.fn(()=>'blob:synthetic-download');URL.revokeObjectURL=vi.fn();return vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})}
const item={agent:{name:'<img src=x>',origin:'external'},receipt:{commandId:'command',summary:'<script>conclusion</script>',limitations:['<svg onload=evil()>'],runtimeManifestSha256:'runtime-hash',artifacts:[{artifactId:'artifact',name:'report.html',mediaType:'text/html',role:'report',inputResultIds:['result'],sizeBytes:3,sha256:'file-hash'}],inputs:[{resultId:'result',sourceId:'metrics',sourceVersion:2,rowCount:3,truncated:true,sha256:'snapshot-hash',queryHash:'query-hash'}]}}
function client(){return {snapshot:()=>[item],error:()=>'',subscribe:()=>()=>{},refresh:vi.fn(async()=>{}),download:vi.fn(async()=>({name:'report.html',bytes:new Uint8Array([1,2,3]),current:()=>true}))}}
test('renders only escaped receipt metadata, truncation and distinct checksums, never active previews',()=>{
 const html=renderToStaticMarkup(h(AnalysisDeliveryPanel,{client:client() as never,lang:'en'}))
 expect(html).toContain('Analysis deliveries');expect(html).toContain('Automatically generated content remains unverified');expect(html).toContain('Committed does not mean inserted into or saved');expect(html).toContain('Untrusted analysis');expect(html).toContain('TRUNCATED');expect(html).toContain('snapshot-hash');expect(html).toContain('file-hash');expect(html).toContain('runtime-hash')
 expect(html).toContain('&lt;script&gt;');expect(html).not.toMatch(/<script|<iframe|<img|<svg|href=/);expect(html).toContain('report.html')
})
test('only an explicit download click offers an inert attachment',async()=>{
 const fake=client(),offer=spyDownload();const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 try {await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:fake as never,lang:'en'})));expect(fake.download).not.toHaveBeenCalled();expect(offer).not.toHaveBeenCalled();await act(async()=>host.querySelector('button')!.click());expect(fake.download).toHaveBeenCalledWith('command','artifact');expect(offer).toHaveBeenCalledTimes(1);expect((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]![0].type).toBe('application/octet-stream')}finally{await act(async()=>root.unmount());host.remove()}
})
test('late download completion after unmount or invalidation never clicks a link',async()=>{
 for(const unmount of [false,true]) {
  let release!:(x:unknown)=>void;const fake=client();fake.download=vi.fn(()=>new Promise(resolve=>release=resolve)) as never
  const offer=spyDownload(),host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:fake as never,lang:'en'})))
  await act(async()=>host.querySelector('button')!.click());if(unmount)await act(async()=>root.unmount())
  await act(async()=>release({name:'report.html',bytes:new Uint8Array([1]),current:()=>unmount}))
  expect(offer).not.toHaveBeenCalled();if(!unmount)await act(async()=>root.unmount());host.remove()
 }
})
test('replacing the bound client invalidates a pending old download',async()=>{
 let release!:(x:unknown)=>void;const old=client(),next=client();old.download=vi.fn(()=>new Promise(resolve=>release=resolve)) as never
 const offer=spyDownload(),host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:old as never,lang:'en'})));await act(async()=>host.querySelector('button')!.click());await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:next as never,lang:'en'})));await act(async()=>release({name:'report.html',bytes:new Uint8Array([1]),current:()=>true}));expect(offer).not.toHaveBeenCalled()}finally{await act(async()=>root.unmount());host.remove()}
})

test('empty limitations are unspecified, not a completeness guarantee',()=>{const fake=client();fake.snapshot=()=>[{...item,receipt:{...item.receipt,limitations:[]}}];const html=renderToStaticMarkup(h(AnalysisDeliveryPanel,{client:fake as never,lang:'en'}));expect(html).toContain('No limitations supplied; this is not a guarantee of completeness.')})

function insertionFixture(){
 const row=structuredClone(item);Object.assign(row.receipt.artifacts[0],{name:'report.txt',mediaType:'text/plain',role:'report',sha256:'a'.repeat(64)})
 const target={fileId:'file',format:'docx',capture:vi.fn(()=>({token:'capture',fileId:'file',format:'docx',baseRevision:'r1',leaseEpoch:1})),apply:vi.fn(async(_capture,_content,_artifact,authorized)=>{if(!authorized())throw Error();return {status:'applied_uncommitted',applicationId:'applied'}}),save:vi.fn(async(_id,authorized)=>{if(!authorized())throw Error();return {status:'saved',applicationId:'applied',receipt:{fileId:'file',revision:'r2',sha256:'b'.repeat(64),size:20}}})}
 let selected:typeof target|undefined=target;const listeners=new Set<()=>void>();const documents={current:()=>selected,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)}}
 const fake={...client(),snapshot:()=>[row],download:vi.fn(async()=>({name:'report.txt',receipt:row.receipt,artifact:row.receipt.artifacts[0],bytes:new Uint8Array(new TextEncoder().encode('<script>literal</script>')),current:()=>true})),authorize:vi.fn(async()=>({artifact:row.receipt.artifacts[0],current:()=>true}))}
 return {fake,target,documents,replace(){selected=undefined;for(const fn of listeners)fn()}}
}
const button=(host:HTMLElement,name:string)=>[...host.querySelectorAll('button')].find(x=>x.textContent===name)!
test('explicit insert uses literal content and never auto-saves; separate save displays actual revision',async()=>{
 const f=insertionFixture(),host=document.createElement('div'),root=createRoot(host);document.body.append(host)
 try {
  await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'})))
  expect(f.target.apply).not.toHaveBeenCalled();expect(f.target.save).not.toHaveBeenCalled()
  await act(async()=>button(host,'Insert into document').click())
  expect(f.target.apply).toHaveBeenCalledTimes(1);expect(f.target.apply.mock.calls[0]![1]).toMatchObject({kind:'text'});expect((f.target.apply.mock.calls[0]![1] as {text:string}).text).toContain('<script>literal</script>');expect((f.target.apply.mock.calls[0]![1] as {text:string}).text).toContain('TRUNCATED: not the full dataset');expect(f.target.save).not.toHaveBeenCalled();expect(host.textContent).toContain('Applied, not saved')
  await act(async()=>button(host,'Save document').click());expect(f.fake.authorize).toHaveBeenCalledWith('command','artifact');expect(f.target.save).toHaveBeenCalledTimes(1);expect(host.textContent).toContain('r2')
 }finally{await act(async()=>root.unmount());host.remove()}
})
test('download completing after target replacement cannot apply and does not retry',async()=>{
 const f=insertionFixture();let release!:(x:unknown)=>void;f.fake.download=vi.fn(()=>new Promise(r=>release=r)) as never
 const host=document.createElement('div'),root=createRoot(host)
 try{await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'})));await act(async()=>button(host,'Insert into document').click());await act(async()=>f.replace());await act(async()=>release({name:'report.txt',receipt:f.fake.snapshot()[0]!.receipt,artifact:f.fake.snapshot()[0]!.receipt.artifacts[0],bytes:new Uint8Array(new TextEncoder().encode('stale')),current:()=>true}));expect(f.target.apply).not.toHaveBeenCalled();expect(f.target.save).not.toHaveBeenCalled()}finally{await act(async()=>root.unmount())}
})
test('revoked save authorization never calls document save or claims saved',async()=>{
 const f=insertionFixture();f.fake.authorize=vi.fn(async()=>{throw Error('revoked')});const host=document.createElement('div'),root=createRoot(host)
 try{await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'})));await act(async()=>button(host,'Insert into document').click());await act(async()=>button(host,'Save document').click());expect(f.target.save).not.toHaveBeenCalled();expect(host.textContent).toContain('not confirmed')}finally{await act(async()=>root.unmount())}
})
test('unsupported HTML remains download-only even with an active document',async()=>{
 const f=insertionFixture();f.fake.snapshot=()=>[item] as never
 const html=renderToStaticMarkup(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'}))
 expect(html).toContain('Download');expect(html).not.toContain('Insert into document');expect(f.target.capture).not.toHaveBeenCalled()
})
test('synchronous double-click captures once before download and never duplicates apply',async()=>{
 const f=insertionFixture(),host=document.createElement('div'),root=createRoot(host)
 f.fake.download.mockImplementation(async()=>{expect(f.target.capture).toHaveBeenCalledTimes(1);return {name:'report.txt',receipt:f.fake.snapshot()[0]!.receipt,artifact:f.fake.snapshot()[0]!.receipt.artifacts[0],bytes:new Uint8Array([120]),current:()=>true}})
 try{await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'})));const insert=button(host,'Insert into document');await act(async()=>{insert.click();insert.click()});expect(f.fake.download).toHaveBeenCalledTimes(1);expect(f.target.apply).toHaveBeenCalledTimes(1)}finally{await act(async()=>root.unmount())}
})
test('unmount or client replacement stops a late insertion and the queued authorization closure',async()=>{
 for(const replace of [false,true]){
  const f=insertionFixture(),host=document.createElement('div'),root=createRoot(host);let resume!:()=>void
  f.target.apply.mockImplementation(async(_capture,_content,_artifact,authorized)=>{await new Promise<void>(r=>resume=r);expect(authorized()).toBe(false);throw Error('cancelled')})
  await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'})))
  await act(async()=>button(host,'Insert into document').click())
  if(replace)await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:client() as never,documents:f.documents as never,lang:'en'})));else await act(async()=>root.unmount())
  await act(async()=>resume());expect(f.target.save).not.toHaveBeenCalled();if(replace){expect(host.textContent).not.toContain('Applied, not saved');await act(async()=>root.unmount())}
 }
})
test('ambiguous or mismatched save never reports saved or allows a blind second save',async()=>{
 for(const bad of [{status:'not_confirmed',reason:'unknown'},{status:'saved',applicationId:'other',receipt:{fileId:'file',revision:'r2',sha256:'b'.repeat(64),size:20}},{status:'saved',applicationId:'applied',receipt:{fileId:'other',revision:'r2',sha256:'b'.repeat(64),size:20}}]){
  const f=insertionFixture(),host=document.createElement('div'),root=createRoot(host);f.target.save.mockResolvedValue(bad as never)
  try{await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'})));await act(async()=>button(host,'Insert into document').click());await act(async()=>button(host,'Save document').click());expect(host.textContent).toContain('Save not confirmed');expect(host.textContent).not.toContain('Saved revision:');expect(button(host,'Save document')).toBeUndefined();expect(f.target.save).toHaveBeenCalledTimes(1)}finally{await act(async()=>root.unmount())}
 }
})
test('ambiguous apply is not automatically repeated',async()=>{
 const f=insertionFixture(),host=document.createElement('div'),root=createRoot(host);f.target.apply.mockRejectedValue(Error('unknown outcome'))
 try{await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'})));await act(async()=>button(host,'Insert into document').click());expect(host.textContent).toContain('Insertion not confirmed');expect(button(host,'Insert into document')).toBeUndefined();expect(f.target.apply).toHaveBeenCalledTimes(1)}finally{await act(async()=>root.unmount())}
})
test('target replacement while save is queued invalidates the mandatory authorization closure',async()=>{
 const f=insertionFixture(),host=document.createElement('div'),root=createRoot(host);let resume!:()=>void
 f.target.save.mockImplementation(async(_id,authorized)=>{await new Promise<void>(r=>resume=r);expect(authorized()).toBe(false);return {status:'saved',applicationId:'applied',receipt:{fileId:'file',revision:'stale-revision',sha256:'b'.repeat(64),size:20}}})
 try{await act(async()=>root.render(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang:'en'})));await act(async()=>button(host,'Insert into document').click());await act(async()=>button(host,'Save document').click());await act(async()=>f.replace());await act(async()=>resume());expect(host.textContent).not.toContain('stale-revision');expect(host.textContent).not.toContain('Saved revision:')}finally{await act(async()=>root.unmount())}
})

test('target-specific insertion warning discloses spreadsheet overwrite and document placement',()=>{
 for(const [format,en,zh] of [['xlsx','overwrite the destination cells','覆盖目标单元格'],['docx','after the current paragraph','当前段落后插入']]){
  const f=insertionFixture();f.target.format=format as never
  for(const lang of ['en','zh'] as const){const html=renderToStaticMarkup(h(AnalysisDeliveryPanel,{client:f.fake as never,documents:f.documents as never,lang}));expect(html).toContain(lang==='en'?en:zh);expect(html).toContain(lang==='en'?'not saved':'尚未保存');expect(html).toContain(lang==='en'?'Undo':'撤销');if(format==='xlsx')expect(html).toContain(lang==='en'?'Write to selection':'写入当前选区')}
 }
})

test('source display renders recorded units/timezone as text and labels legacy omissions',()=>{
 const f=insertionFixture(),row=f.fake.snapshot()[0]!;Object.assign(row.receipt.inputs[0]!,{timezone:'Asia/Shanghai',schema:[{name:'<img src=x>',type:'number',unit:'<script>CNY</script>'}]})
 const html=renderToStaticMarkup(h(AnalysisDeliveryPanel,{client:f.fake as never,lang:'en'}));expect(html).toContain('Asia/Shanghai');expect(html).toContain('&lt;script&gt;CNY&lt;/script&gt;');expect(html).toContain('number');expect(html).not.toMatch(/<img|<script/)
 const legacy=renderToStaticMarkup(h(AnalysisDeliveryPanel,{client:client() as never,lang:'en'}));expect(legacy).toContain('Timezone: not recorded');expect(legacy).toContain('Column types and units: not recorded')
})
