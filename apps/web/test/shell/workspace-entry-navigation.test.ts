import {expect,test,vi} from 'vitest'
import {createDocumentTabs} from '../../src/shell/document-tabs'
import {createEntryNavigator} from '../../src/shell/workspace-entry-navigation'
const a={id:'a',name:'A',format:'docx' as const,src:'/native-docx/?fileId=a'},b={...a,id:'b',name:'B'}
function setup(){const tabs=createDocumentTabs(),pending=new Map<string,{resolve:(v:typeof a)=>void;reject:(e:Error)=>void}>(),replace=vi.fn(),error=vi.fn();let allowed=true
 const nav=createEntryNavigator({tabs,resolve:id=>new Promise((resolve,reject)=>pending.set(id,{resolve,reject})),allow:()=>allowed,onStart:vi.fn(),onError:error,replace,markRouting:vi.fn()})
 return {tabs,nav,pending,replace,error,block:()=>{allowed=false}}
}
test('later Home supersedes delayed file success without opening or selecting it',async()=>{
 const f=setup(),first=f.nav.navigate('a');await f.nav.navigate('home');f.pending.get('a')!.resolve(a);await first
 expect(f.tabs.list().find(t=>t.active)?.id).toBe('home');expect(f.tabs.documents()).toEqual([]);expect(f.replace).toHaveBeenLastCalledWith('home')
})
test('late failure cannot replace newer route or ordinary tab activation',async()=>{
 const f=setup(),first=f.nav.navigate('a'),second=f.nav.navigate('b');f.pending.get('b')!.resolve(b);await second;f.pending.get('a')!.reject(Error('old'));await first
 expect(f.tabs.list().find(t=>t.active)?.id).toBe('b');expect(f.error).not.toHaveBeenCalled()
 const third=f.nav.navigate('a');f.tabs.activate('home');f.pending.get('a')!.reject(Error('old'));await third;expect(f.tabs.list().find(t=>t.active)?.id).toBe('home');expect(f.error).not.toHaveBeenCalled()
})
test('dirty settings refuse history navigation, cancel stale pending selection and retain current entry',async()=>{
 const f=setup(),first=f.nav.navigate('a');f.block();await f.nav.navigate('b');expect(f.pending.has('b')).toBe(false);f.pending.get('a')!.resolve(a);await first;expect(f.tabs.documents()).toEqual([]);expect(f.replace).toHaveBeenLastCalledWith('home')
})
test('disposing navigator blocks all late publication',async()=>{
 const f=setup(),first=f.nav.navigate('a');f.nav.dispose();f.pending.get('a')!.resolve(a);await first;expect(f.tabs.documents()).toEqual([])
})
test('bound session rejects another tab cookie rotation before foreign metadata can become an entry',async()=>{
 const {createLocalShellClient}=await import('../../src/shell/local-client')
 let proof='a'.repeat(43);const requests:string[]=[]
 const client=createLocalShellClient((async(path:string)=>{
  requests.push(path)
  if(path==='/api/v1/auth/session-proof')return new Response(JSON.stringify({csrfToken:proof}),{status:200})
  proof='b'.repeat(43)
  return new Response(JSON.stringify(a),{status:200})
 }) as typeof fetch)
 const {readOpenDocument}=await import('../../src/shell/document-entry-reader')
 const bound=await client.bindSession(),tabs=createDocumentTabs(),errors:unknown[]=[]
 const nav=createEntryNavigator({tabs,resolve:id=>readOpenDocument({bound},{docx:'editable'},id),allow:()=>true,onStart(){},onError:e=>errors.push(e),replace(){},markRouting(){}})
 await nav.navigate('a')
 expect(tabs.documents()).toEqual([]);expect(errors).toHaveLength(1);expect(errors[0]).toMatchObject({code:'stale_session'});expect(requests.filter(p=>p.includes('/files/'))).toEqual(['/api/v1/files/a'])
})
test('entry reader validates metadata before recording open and rechecks bound session after POST',async()=>{
 const {readOpenDocument}=await import('../../src/shell/document-entry-reader')
 const id='11111111-1111-4111-8111-111111111111',revision='revision-1',calls:string[]=[]
 const metadata={name:'A',format:'docx',file:{fileId:id,revision},downloadEndpoint:`/api/v1/files/${id}/content?revision=${revision}`}
 let revoked=false
 const workspace={bound:{async request<T>(path:string,method?:string):Promise<T>{calls.push(method??'GET');if(method==='POST'&&revoked)throw Object.assign(Error(),{code:'stale_session'});return metadata as T}}}
 expect((await readOpenDocument(workspace,{docx:'editable'},id)).src).toBe(`/native-docx/?fileId=${id}`)
 expect(calls).toEqual(['GET','POST'])
 revoked=true;await expect(readOpenDocument(workspace,{docx:'editable'},id)).rejects.toMatchObject({code:'stale_session'})
 metadata.file.fileId='foreign';calls.length=0;await expect(readOpenDocument(workspace,{},id)).rejects.toThrow();expect(calls).toEqual(['GET'])
})
test('PDF opens the native editor only when the workspace enables it',async()=>{
 const {resolvedDocument}=await import('../../src/shell/document-entry-reader')
 const id='11111111-1111-4111-8111-111111111111',revision='revision-1'
 const metadata={name:'A.pdf',format:'pdf',file:{fileId:id,revision},downloadEndpoint:`/api/v1/files/${id}/content?revision=${revision}`}
 expect(()=>resolvedDocument({pdf:'editable'},id,metadata)).toThrow('当前 PDF 编辑器未启用')
 expect(resolvedDocument({pdf:'editable',pdfEditor:'editable'},id,metadata).src).toBe(`/native-pdf/?fileId=${id}`)
})
