import {expect,test,vi,afterEach} from 'vitest'
import {createElement as h,act} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {createRoot} from 'react-dom/client'
import {AnalysisDeliveryPanel} from '../../src/editors/analysis-delivery-panel'
const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL
afterEach(()=>{vi.restoreAllMocks();URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke})
function spyDownload(){URL.createObjectURL=vi.fn(()=>'blob:synthetic-download');URL.revokeObjectURL=vi.fn();return vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})}
const item={agent:{name:'<img src=x>',origin:'external'},receipt:{commandId:'command',summary:'<script>conclusion</script>',limitations:['<svg onload=evil()>'],runtimeManifestSha256:'runtime-hash',artifacts:[{artifactId:'artifact',name:'report.html',mediaType:'text/html',role:'report',sizeBytes:3,sha256:'file-hash'}],inputs:[{resultId:'result',sourceId:'metrics',sourceVersion:2,rowCount:3,truncated:true,sha256:'snapshot-hash',queryHash:'query-hash'}]}}
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
