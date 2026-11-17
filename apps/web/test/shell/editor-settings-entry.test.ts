import {afterEach,expect,test,vi} from 'vitest'
import {createEditorAssistant} from '../../src/editors/assistant'
afterEach(()=>vi.unstubAllGlobals())
async function assistant(){vi.stubGlobal('fetch',vi.fn(async(path:string)=>new Response(JSON.stringify(path==='/api/v1/auth/session-proof'?{csrfToken:'p'.repeat(43)}:{entries:[]}))));return createEditorAssistant()}
test.each(['openSkillsSettings','openAiModelSettings'] as const)('%s requests the host without replacing the editor document',async method=>{
 const open=vi.fn(),navigate=vi.fn(),alert=vi.fn();vi.stubGlobal('window',{parent:{location:{origin:'http://localhost'},dyofficeOpenEditorSettings:open},location:{origin:'http://localhost'},alert});vi.stubGlobal('location',{assign:navigate})
 const client=await assistant();try{await client.api[method]();expect(open).toHaveBeenCalledWith(method==='openSkillsSettings'?'skills':'models',window);expect(navigate).not.toHaveBeenCalled();expect(alert).not.toHaveBeenCalled()}finally{client.dispose()}
})
test.each(['standalone','missing','cross-origin'])('%s host explains the limitation without navigation',async mode=>{
 const navigate=vi.fn(),alert=vi.fn(),standalone={location:{origin:'http://localhost'},alert};const parent=mode==='standalone'?standalone:mode==='missing'?{location:{origin:'http://localhost'}}:{location:{origin:'https://other.test'}};Object.assign(standalone,{parent});vi.stubGlobal('window',standalone);vi.stubGlobal('location',{assign:navigate})
 const client=await assistant();try{await client.api.openSkillsSettings();expect(alert).toHaveBeenCalledWith(expect.stringContaining('工作区'));expect(navigate).not.toHaveBeenCalled()}finally{client.dispose()}
})
