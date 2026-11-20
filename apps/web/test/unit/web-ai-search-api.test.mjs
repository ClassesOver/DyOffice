import test from 'node:test'
import assert from 'node:assert/strict'
import {createWebAiSearchApi,officeToolsWithConfiguredAiTools} from '../../src/editors/web-ai-search-api.ts'

test('search bridge sends bounded GenOffice tool input through the same-origin API',async()=>{
 const calls=[]
 const api=createWebAiSearchApi(async(...args)=>{calls.push(args);return args[2].kind==='web_search'?{results:[],method:'serper'}:{images:[],method:'serper'}})
 assert.deepEqual(await api.webSearch('latest office format',5),{results:[],method:'serper'})
 assert.deepEqual(await api.imageSearch('office desk',7),{images:[],method:'serper'})
 assert.deepEqual(calls,[
  ['/api/v1/ai/search','POST',{kind:'web_search',query:'latest office format',maxResults:5}],
  ['/api/v1/ai/search','POST',{kind:'image_search',query:'office desk',maxResults:7}],
 ])
})

test('offers only search tools whose default provider is enabled for that kind',()=>{
 const base=new Set(['get_document_context','read_blocks','web_search','image_search'])
 const result=officeToolsWithConfiguredAiTools(base,{defaults:{web_search:'web-1',image_search:'web-1'},catalog:[
  {id:'web-1',kind:'web_search',ready:true},
  {id:'image-1',kind:'image_search',ready:true},
 ]})
 assert.deepEqual([...result].sort(),['get_document_context','read_blocks','web_search'])
 const unavailable=officeToolsWithConfiguredAiTools(new Set(['read_blocks','web_search','image_search','generate_image','analyze_media']),{defaults:{web_search:'web-1',image_generation:'image-1',image_analysis:'analysis-1'},catalog:[{id:'web-1',kind:'web_search',ready:false},{id:'image-1',kind:'image_generation',ready:false},{id:'analysis-1',kind:'image_analysis',ready:false}]},'docx')
 assert.equal(unavailable.has('web_search'),false)
 assert.equal(unavailable.has('image_search'),false)
 assert.equal(unavailable.has('generate_image'),false)
 assert.equal(unavailable.has('analyze_media'),false)
 const noSettings=officeToolsWithConfiguredAiTools(new Set(['read_blocks','web_search','image_search','generate_image','analyze_media']),{},'docx')
 assert.equal(noSettings.has('web_search'),false)
 assert.equal(noSettings.has('image_search'),false)
})

test('exposes GenOffice media tools only where their configured provider is ready and the format can use them',()=>{
 const base=new Set(['read_blocks','web_search','image_search','generate_image','analyze_media'])
 const settings={defaults:{image_generation:'image-1',image_analysis:'analysis-1'},catalog:[
  {id:'image-1',kind:'image_generation',ready:true},
  {id:'analysis-1',kind:'image_analysis',ready:true},
 ]}
 const docx=officeToolsWithConfiguredAiTools(base,settings,'docx')
 assert.equal(docx.has('generate_image'),true);assert.equal(docx.has('analyze_media'),true)
 const sheets=officeToolsWithConfiguredAiTools(base,settings,'xlsx')
 assert.equal(sheets.has('generate_image'),true);assert.equal(sheets.has('analyze_media'),false)
 const slides=officeToolsWithConfiguredAiTools(base,settings,'pptx')
 assert.equal(slides.has('generate_image'),true);assert.equal(slides.has('analyze_media'),true)
 const pdf=officeToolsWithConfiguredAiTools(base,settings,'pdf')
 assert.equal(pdf.has('generate_image'),true);assert.equal(pdf.has('analyze_media'),false)
})
