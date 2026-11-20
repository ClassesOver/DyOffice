import {afterEach, expect, test, vi} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {createEditorAssistant} from '../../src/editors/assistant'

const initialLanguage=document.documentElement.lang
afterEach(()=>{vi.unstubAllGlobals();document.documentElement.lang=initialLanguage})

for(const [initial,preferred,deliveryLabel,taskLabel,wrongDelivery,wrongTask] of [
 ['zh-CN','en','Analysis deliveries','Tasks','分析交付','任务'],
 ['en','zh','分析交付','任务','Analysis deliveries','Tasks'],
]) {
 test(`assistant workspace uses loaded ${preferred} preference rather than initial ${initial} HTML`,async()=>{
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
   const markup=renderToStaticMarkup(assistant.workspace.panel)
   expect(markup).toContain(deliveryLabel)
   expect(markup).not.toContain(wrongDelivery)
   expect(markup).toContain(`aria-label="${taskLabel}"`)
   expect(markup).not.toContain(`aria-label="${wrongTask}"`)
  } finally {assistant.dispose()}
 })
}
