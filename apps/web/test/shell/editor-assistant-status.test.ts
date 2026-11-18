import {afterEach,expect,test,vi} from 'vitest'
import {loadEditorAssistant,editorAssistantNotice} from '../../src/editors/editor-assistant-status'
afterEach(()=>vi.unstubAllGlobals())
function http(entries:unknown[]=[]){vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
 if(path==='/api/v1/auth/session-proof')return Response.json({csrfToken:'p'.repeat(43)})
 if(path==='/api/v1/ai/catalog')return Response.json({entries,defaultId:entries.length?'model':null})
 throw Error('Unexpected request: '+path)
}))}
test('real factory empty authorized catalog produces explicit no-model notice without enabling AI',async()=>{
 http();const result=await loadEditorAssistant();try{expect(result.assistant?.available).toBe(false);expect(editorAssistantNotice(result,true,'zh')).toContain('没有可用模型');expect(editorAssistantNotice(result,true,'en')).toContain('No model')}finally{result.assistant?.dispose()}
})
test.each([401,403])('real denied session %s is visible and does not enable assistant',async(status)=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status})));const result=await loadEditorAssistant()
 expect(result.assistant).toBeUndefined();expect(editorAssistantNotice(result,true,'zh')).toContain('登录状态');expect(editorAssistantNotice(result,true,'en')).toContain('session')
})
test('network init failure is explicit but does not echo secret exception data',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('SECRET:token')}));const result=await loadEditorAssistant()
 expect(result.assistant).toBeUndefined();expect(editorAssistantNotice(result,true,'zh')).toContain('加载失败');expect(editorAssistantNotice(result,true,'zh')).not.toContain('SECRET')
})
test('available assistant remains available; hidden preference is explained without overriding it',async()=>{
 http([{id:'model',label:'Model'}]);const result=await loadEditorAssistant()
 try{expect(result.assistant?.available).toBe(true);expect(editorAssistantNotice(result,true,'zh')).toBe('');expect(editorAssistantNotice(result,false,'zh')).toContain('个人设置');expect(editorAssistantNotice(result,false,'en')).toContain('preferences')}finally{result.assistant?.dispose()}
})
test('only DOCX and XLSX use the safe loader and render its notice',async()=>{
 const {readFileSync}=await import('node:fs')
 for(const file of ['native-docs.tsx','sheets-entry.tsx']){const source=readFileSync('src/editors/'+file,'utf8');expect(source).toContain('await loadEditorAssistant(');expect(source).toContain('editorAssistantNotice(assistantResult,prefs.showAssistant,locale)');expect(source).toContain("id:'assistant'");expect(source).not.toContain('{assistantNotice && <span');expect(source).toContain('Boolean(assistant?.available && prefs.showAssistant !== false)');expect(source).not.toContain('.catch(() => undefined)')}
 expect(readFileSync('src/editors/slides-entry.tsx','utf8')).toMatch(/assistantAvailable:\s*false/)
})
