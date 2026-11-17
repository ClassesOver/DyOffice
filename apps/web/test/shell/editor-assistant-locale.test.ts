import {afterEach, expect, test, vi} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {createEditorAssistant} from '../../src/editors/assistant'

const initialLanguage=document.documentElement.lang
afterEach(()=>{vi.unstubAllGlobals();document.documentElement.lang=initialLanguage})

for(const [initial,preferred,label,wrong] of [
 ['zh-CN','en','Analysis deliveries','分析交付'],
 ['en','zh','分析交付','Analysis deliveries'],
]) {
 test(`analysis panel uses loaded ${preferred} preference rather than initial ${initial} HTML`,async()=>{
  // Exercise the real assistant factory and panel; only the HTTP boundary is synthetic.
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
   if(path==='/api/v1/auth/session-proof')return new Response(JSON.stringify({csrfToken:'p'.repeat(43)}))
   if(path==='/api/v1/ai/catalog')return new Response(JSON.stringify({entries:[],agents:[{id:'fixture',name:'Fixture',origin:'external',capabilities:['coding']}]}))
   throw Error('Unexpected request: '+path)
  }))
  document.documentElement.lang=initial
  const assistant=await createEditorAssistant()
  try {
   // Native DOCX loads preferences after binding the assistant, before root.render.
   document.documentElement.lang=preferred
   const markup=renderToStaticMarkup(assistant.modelPicker)
   expect(markup).toContain(label)
   expect(markup).not.toContain(wrong)
  } finally {assistant.dispose()}
 })
}
