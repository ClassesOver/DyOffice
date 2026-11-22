import test from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'
import {assistantToolsForFormat,scopeAssistantRequest} from '../../../../packages/web-contracts/src/assistant.ts'
import {inventory} from '../../../../tools/dyoffice/agent-tool-inventory.mjs'

const encode = new TextEncoder()
for(const format of ['docx','pptx'])for(const mediaAnalysis of [{image:true,video:false},{image:false,video:true},{image:true,video:true}]){
 test(`${format} advertises only configured media inputs (${mediaAnalysis.image}/${mediaAnalysis.video})`,async()=>{
  let sent
  const client=await createAssistantClient({format,mediaAnalysis,nativeToolNames:new Set(['analyze_media']),
   request:async()=>({entries:[{id:'chat',label:'Chat'}],defaultId:'chat'}),csrfToken:'c'.repeat(43),
   fetchImpl:async(_url,init)=>{sent=JSON.parse(init.body).request;return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})}})
  const properties={mediaUrls:{type:'array',description:'Local file paths or URLs'},requirements:{type:'string'},
   ...(format==='docx'?{blockIndex:{type:'integer'},attachmentIndex:{type:'integer'}}:{})}
  await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Analyze this media'}],tools:[{
   name:'analyze_media',description:'Analyze pictures, video/audio and local file paths',
   inputSchema:{type:'object',required:format==='docx'?['requirements']:['mediaUrls','requirements'],properties},
  }]},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
  const [tool]=sent.tools
  assert.equal(tool.name,'analyze_media')
  assert.doesNotMatch(tool.description,/local file/i)
  assert.equal(/image/i.test(tool.inputSchema.properties.mediaUrls.description),mediaAnalysis.image)
  assert.equal(/video or audio/i.test(tool.inputSchema.properties.mediaUrls.description),mediaAnalysis.video)
  assert.equal(Object.hasOwn(tool.inputSchema.properties,'blockIndex'),format==='docx'&&mediaAnalysis.image)
  assert.equal(Object.hasOwn(tool.inputSchema.properties,'attachmentIndex'),format==='docx'&&mediaAnalysis.image)
  assert.equal(tool.inputSchema.required.includes('mediaUrls'),format==='pptx'||!mediaAnalysis.image)
  client.dispose()
 })
}

test('assistant uses server model ID and CSRF, excludes unapproved mutation tools, and retains unknown usage', async () => {
  const sent = [], events = []
  const client = await createAssistantClient({request: async path => path.endsWith('/catalog') ? {entries: [{id: 'user-chat', label: 'Company Chat', model: 'synthetic'}], defaultId: 'user-chat'} : {csrfToken: 'c'.repeat(43)},
    fetchImpl: async (url, init) => {sent.push({url, init}); return new Response(new ReadableStream({start(c) {c.enqueue(encode.encode('event: delta\ndata: {"text":"Answer"}\n\nevent: done\ndata: {}\n\n')); c.close()}}), {headers: {'content-type': 'text/event-stream'}})}
  })
  await new Promise(resolve => client.transport.stream({system: '', messages: [{role: 'user', text: 'hello'}], tools: [{name: 'read_blocks', description: 'Read', inputSchema: {}}, {name: 'apply_ops', description: 'Write', inputSchema: {}}]}, {onDelta: x => events.push(x), onError: x => events.push(x), onToolCall: x => events.push(x), onUsage: x => events.push(x), onDone: resolve}))
  assert.equal(sent[0].init.headers['x-csrf-token'], 'c'.repeat(43))
  const body = JSON.parse(sent[0].init.body)
  assert.equal(body.modelId, 'user-chat')
  assert.deepEqual(body.request.tools.map(t => t.name), ['read_blocks'])
  assert.deepEqual(events, ['Answer'])
  client.dispose()
})

test('assistant rejects a model trying an unoffered tool before AgentLoop can execute it', async () => {
  const calls = []
  const client = await createAssistantClient({request: async path => path.endsWith('/catalog') ? {entries: [{id: 'chat', label: 'Chat', model: 'synthetic'}], defaultId: 'chat'} : {csrfToken: 'c'.repeat(43)}, fetchImpl: async () => new Response('event: tool_call\ndata: {"id":"call1","name":"apply_ops","input":{}}\n\nevent: done\ndata: {}\n\n', {headers: {'content-type': 'text/event-stream'}})})
  await new Promise(resolve => client.transport.stream({system: '', messages: [{role: 'user', text: 'hello'}], tools: []}, {onDelta() {}, onToolCall: x => calls.push(x), onError: x => calls.push('error'), onDone: resolve}))
  assert.deepEqual(calls, ['error'])
  client.dispose()
})

test('assistant transport preserves GenOffice image attachments as multimodal user messages',async()=>{
 const sent=[]
 const client=await createAssistantClient({request:async()=>({entries:[{id:'chat',label:'Chat'}],defaultId:'chat'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{sent.push(JSON.parse(init.body));return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})}})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Describe this',images:[{base64:'aGVsbG8=',mime:'image/png'}]}],tools:[]},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.messages[0].images,[{base64:'aGVsbG8=',mime:'image/png'}])
 client.dispose()
})

test('assistant rejects image requests over the shared 10 MiB wire cap before dispatch',async()=>{
 let dispatched=false;const events=[]
 const client=await createAssistantClient({request:async()=>({entries:[{id:'chat',label:'Chat'}],defaultId:'chat'}),csrfToken:'c'.repeat(43),fetchImpl:async()=>{dispatched=true;return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})}})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Describe',images:[{base64:'a'.repeat(10*1024*1024),mime:'image/png'}]}],tools:[]},{onDelta(){},onToolCall(){},onError:error=>events.push(error),onDone:resolve}))
 assert.equal(dispatched,false);assert.match(events[0],/10 MiB/)
 client.dispose()
})

test('changing the picker only switches endpoints when the next agent run begins', async () => {
  const models = []
  const client = await createAssistantClient({request: async () => ({entries: [{id: 'first'}, {id: 'second'}], defaultId: 'first'}), csrfToken: 'c'.repeat(43),
    fetchImpl: async (_url, init) => {
      models.push(JSON.parse(init.body).modelId)
      return new Response('event: done\ndata: {}\n\n', {headers: {'content-type': 'text/event-stream'}})
    },
  })
  const stream = () => new Promise(resolve => client.transport.stream({system: '', messages: [{role: 'user', text: 'hello'}], tools: []}, {onDelta() {}, onToolCall() {}, onError: assert.fail, onDone: resolve}))
  assert.equal(client.transport.beginRun(), false)
  await stream()
  client.select('second')
  await stream()
  assert.equal(client.transport.beginRun(), true, 'AgentLoop must start with empty history on a provider change')
  await stream()
  assert.deepEqual(models, ['first', 'first', 'second'])
})

test('disposing an editor assistant cancels its live turn and rejects later sends', async () => {
  const requests = [], events = []
  let started
  const dispatched = new Promise(resolve => { started = resolve })
  const client = await createAssistantClient({
    request: async () => ({entries: [{id: 'chat', label: 'Chat', model: 'synthetic'}], defaultId: 'chat'}),
    csrfToken: 'c'.repeat(43),
    fetchImpl: async (url, init) => {
      requests.push({url, init})
      if (url.endsWith('/cancel')) return new Response(null, {status: 204})
      started()
      return new Response(new ReadableStream({start() {}}), {headers: {'content-type': 'text/event-stream'}})
    },
  })
  const input = {system: '', messages: [{role: 'user', text: 'hello'}], tools: []}
  const done = new Promise(resolve => client.transport.stream(input, {onDelta() {}, onToolCall() {}, onError: assert.fail, onDone: resolve}))
  await dispatched
  client.dispose()
  await done
  assert.equal(requests[0].init.signal.aborted, true)
  assert.equal(requests.filter(r => r.url.endsWith('/cancel')).length, 1)
  assert.equal(requests[1].init.headers['x-csrf-token'], 'c'.repeat(43))
  client.transport.stream(input, {onDelta() {}, onToolCall() {}, onError: value => events.push(value), onDone: () => events.push('done')})
  assert.deepEqual(events, ['助手当前不可用。', 'done'])
  assert.equal(requests.length, 2, 'disposed editor must not dispatch another turn')
  assert.throws(() => client.select('chat'))
})

test('native editor retains writing tools and accepts their calls while excluding shell execution',async()=>{
 const sent=[],calls=[]
 const client=await createAssistantClient({nativeDocumentEditing:true,request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body))
  return new Response('event: tool_call\ndata: {"id":"write1","name":"write_document","input":{"plan":"Write a short report"}}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'Write into the open document.',messages:[{role:'user',text:'Write a document'}],tools:['write_document','insert_content','replace_blocks','replace_selection','apply_ops','delete_blocks','exec_command'].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall:call=>calls.push(call),onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['write_document','insert_content','replace_blocks','replace_selection','apply_ops'])
 assert.doesNotMatch(sent[0].request.system,/Document mutation.*unavailable/)
 assert.equal(calls[0].name,'write_document')
 client.dispose()
})

test('format-specific native tool names include workbook merge and exclude other formats',async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'xlsx',nativeToolNames:new Set(['get_workbook_context','read_attachment','select_range','propose_operations','merge_attached_workbooks']),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body))
  return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Update the workbook'}],tools:[
  ...['get_workbook_context','read_attachment','select_range','propose_operations','merge_attached_workbooks','write_document','read_blocks'].map(name=>({name,description:name,inputSchema:{}})),
 ]},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.equal(sent[0].request.format,'xlsx')
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['get_workbook_context','read_attachment','select_range','propose_operations','merge_attached_workbooks'])
 client.dispose()
})

test('PDF preview assistant sends read, navigation, and rotation tools with the PDF format',async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'pdf',nativeToolNames:new Set(['read_pages','search_text','goto_page','rotate_pages']),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body))
  return new Response('event: done\\ndata: {}\\n\\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Find the total'}],tools:['read_pages','search_text','goto_page','rotate_pages','edit_text','write_document'].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.equal(sent[0].request.format,'pdf')
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['read_pages','search_text','goto_page','rotate_pages'])
 assert.match(sent[0].request.system,/page rotation only/)
 client.dispose()
})

test('PPTX assistant sends the explicit GenOffice format tool inventory',async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'pptx',nativeToolNames:new Set(['read_slide','apply_ops']),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body))
  return new Response('event: done\\ndata: {}\\n\\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Revise slide two'}],tools:['read_slide','apply_ops','write_document'].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['read_slide','apply_ops'])
 client.dispose()
})

test('PDF editing instructions follow the tools actually offered to the model',async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'pdf',nativeToolNames:new Set(['read_pages','edit_text']),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body))
  return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Change the title'}],tools:['read_pages','edit_text','rotate_pages'].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['read_pages','edit_text'])
 assert.doesNotMatch(sent[0].request.system,/read-only|rotation only/)
 assert.match(sent[0].request.system,/original text/)
 client.dispose()
})

test('native PDF distinguishes drafts, confirmed page saves and new copies in one turn',async()=>{
 const sent=[],names=['edit_text','crop_pages','set_page_size','replace_pages','extract_pages']
 const client=await createAssistantClient({format:'pdf',nativeDocumentEditing:true,nativeToolNames:new Set(names),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body))
  return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 const send=tools=>new Promise(resolve=>client.transport.stream({system:'',messages:[],tools:tools.map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 await send([...names,'split_pdf'])
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),names)
 assert.match(sent[0].request.system,/crop_pages, set_page_size, replace_pages.*user confirmation.*new revision/)
 assert.match(sent[0].request.system,/extract_pages.*separate saved PDF/)
 assert.doesNotMatch(sent[0].request.system,/split_pdf/)
 assert.match(sent[0].request.system,/draft.*Never claim a draft has been saved/)
 await send(['edit_text'])
 assert.doesNotMatch(sent[1].request.system,/crop_pages|replace_pages|extract_pages/)
 client.dispose()
})

test('format assistant intersects editor tools with SaaS-supported tools',async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'docx',nativeToolNames:new Set(['get_document_context','web_search','create_document','read_slide']),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body))
  return new Response('event: done\\ndata: {}\\n\\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Summarize'}],tools:['get_document_context','web_search','create_document','read_slide'].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['get_document_context','web_search','create_document'])
 client.dispose()
})

test('server assistant tool policy matches the four GenOffice tool inventories',()=>{
 assert.deepEqual(['docx','xlsx','pptx','pdf'].map(format=>assistantToolsForFormat(format).size),[42,19,20,49])
 assert.equal(assistantToolsForFormat('docx').has('read_attachment'),true)
 assert.equal(assistantToolsForFormat('xlsx').has('read_attachment'),true)
 assert.equal(assistantToolsForFormat('docx').has('analyze_media'),true)
 assert.equal(assistantToolsForFormat('docx').has('generate_image'),true)
 for(const name of ['set_page_setup','insert_section_break','define_style','list_styles','set_watermark','insert_text_box','insert_picture','create_document','generate_mindmap']) assert.equal(assistantToolsForFormat('docx').has(name),true)
 assert.equal(assistantToolsForFormat('xlsx').has('create_document'),true)
 assert.equal(assistantToolsForFormat('xlsx').has('merge_attached_workbooks'),true)
 assert.equal(assistantToolsForFormat('pptx').has('read_attachment'),true)
 for(const name of ['insert_web_image','replace_image','regenerate_slide','generate_deck','save_style_template','list_style_templates','edit_chart']) assert.equal(assistantToolsForFormat('pptx').has(name),true)
 const scoped=scopeAssistantRequest({format:'xlsx',system:'',messages:[],tools:[{name:'propose_operations'},{name:'create_document'},{name:'write_document'}]},new Set())
 assert.equal(scoped.request.format,undefined)
 assert.deepEqual(scoped.request.tools.map(tool=>tool.name),['propose_operations','create_document'])
 assert.ok(scoped.tools.has('propose_operations'))
 assert.equal(scoped.tools.has('select_range'),false)
 const office=scopeAssistantRequest({format:'docx',system:'',messages:[],tools:['get_document_context','web_search','image_search','analyze_media','generate_image','create_document','set_page_setup','generate_mindmap'].map(name=>({name}))},new Set())
 assert.deepEqual(office.request.tools.map(tool=>tool.name),['get_document_context','web_search','image_search','analyze_media','generate_image','create_document','set_page_setup','generate_mindmap'])
 const sheets=scopeAssistantRequest({format:'xlsx',system:'',messages:[],tools:['get_workbook_context','create_document','merge_attached_workbooks','web_search'].map(name=>({name}))},new Set())
 assert.deepEqual(sheets.request.tools.map(tool=>tool.name),['get_workbook_context','create_document','merge_attached_workbooks','web_search'])
 const slides=scopeAssistantRequest({format:'pptx',system:'',messages:[],tools:['read_slide','generate_deck','insert_web_image','save_style_template','edit_chart'].map(name=>({name}))},new Set())
 assert.deepEqual(slides.request.tools.map(tool=>tool.name),['read_slide','generate_deck','insert_web_image','save_style_template','edit_chart'])
 const pdf=scopeAssistantRequest({format:'pdf',system:'',messages:[],tools:['read_pages','rotate_pages','edit_text'].map(name=>({name}))},new Set())
 assert.deepEqual(pdf.request.tools.map(tool=>tool.name),['read_pages','rotate_pages','edit_text'])
 assert.throws(()=>scopeAssistantRequest({format:'unknown',tools:[]},new Set()))
})

test('format-scoped provider rejects tools that were not offered in this turn',()=>{
 const scoped=scopeAssistantRequest({format:'pdf',system:'',messages:[],tools:[{name:'read_pages'},{name:'search_text'}]},new Set())
 assert.deepEqual([...scoped.tools].sort(),['read_pages','search_text'])
 assert.equal(scoped.tools.has('edit_text'),false)
})

test('SaaS format allowlists include every declared PC document tool except local CLI execution',async()=>{
 const rows=await inventory()
 for(const [app,format] of [['docs','docx'],['sheets','xlsx'],['slides','pptx'],['pdf','pdf']]){
  const declared=new Set(rows.filter(row=>row.file.startsWith('apps/'+app+'/src/renderer/ai/')).map(row=>row.name))
  const allowed=assistantToolsForFormat(format)
  assert.deepEqual([...declared].filter(name=>!allowed.has(name)),format==='docx'?['run_cli']:[],format)
 }
})

test('PDF annotation instructions follow the offered mutation tools without claiming read-only',async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'pdf',nativeToolNames:new Set(['read_annotations','delete_note']),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body))
  return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Delete my comment'}],tools:['read_annotations','delete_note','edit_text'].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['read_annotations','delete_note'])
 assert.doesNotMatch(sent[0].request.system,/read-only|rotation only|edit original text/)
 assert.match(sent[0].request.system,/annotation/)
 client.dispose()
})

for(const name of ['reply_note','edit_note'])test(`PDF ${name} instructions recognize the offered note writer`,async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'pdf',nativeToolNames:new Set(['read_annotations',name]),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body));return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[],tools:['read_annotations',name].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['read_annotations',name])
 assert.doesNotMatch(sent[0].request.system,/read-only|rotation only/)
 assert.match(sent[0].request.system,/annotation/)
 client.dispose()
})

for(const name of ['apply_ops','insert_blank_page','set_page_size','crop_pages'])test(`PDF ${name} prompt requires fresh page numbers after saving`,async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'pdf',nativeToolNames:new Set(['read_pages',name]),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body));return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[],tools:['read_pages',name].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['read_pages',name])
 assert.doesNotMatch(sent[0].request.system,/read-only|rotation only/)
 assert.match(sent[0].request.system,/original page numbers/)
 assert.match(sent[0].request.system,/re-read pages and annotations/)
 assert.match(sent[0].request.system,/not protection or writability/)
 assert.match(sent[0].request.system,/CropBox.*not redact/)
 client.dispose()
})

for(const creationTool of ['extract_pages','split_pdf','split_pages','merge_pages'])test(`PDF ${creationTool}-only prompt describes new file creation without granting source edits`,async()=>{
 const sent=[]
 const client=await createAssistantClient({format:'pdf',nativeToolNames:new Set(['read_pages',creationTool]),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body));return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[],tools:['read_pages',creationTool].map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),['read_pages',creationTool])
 assert.doesNotMatch(sent[0].request.system,/read-only|rotation only/)
 assert.match(sent[0].request.system,/new saved PDF/)
 assert.match(sent[0].request.system,/source keeps its pages/)
 assert.match(sent[0].request.system,/Partial or canceled batches are not full success/)
 client.dispose()
})

test('PDF saved form reads and sensitive lookup are offered without granting filling or redaction',async()=>{
 const sent=[],names=['read_pages','list_form_fields','find_sensitive_info']
 const client=await createAssistantClient({format:'pdf',nativeToolNames:new Set(names),request:async()=>({entries:[{id:'office',label:'Office'}],defaultId:'office'}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(init.body));return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 await new Promise(resolve=>client.transport.stream({system:'',messages:[],tools:names.map(name=>({name,description:name,inputSchema:{}}))},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
 assert.deepEqual(sent[0].request.tools.map(tool=>tool.name),names)
 assert.match(sent[0].request.system,/read-only/)
 client.dispose()
})

test('Word knowledge tools survive format scoping while other editor formats retain their existing tools',()=>{
 const tools=[{name:'read_knowledge_file'},{name:'search_knowledge_base'}]
 const request={format:'docx',system:'',messages:[],tools}
 assert.deepEqual(scopeAssistantRequest(request,new Set()).request.tools,tools)
 assert.deepEqual(scopeAssistantRequest({...request,format:'xlsx'},new Set()).request.tools,[])
})

test('read-only source tools reach every format and unavailable tools cannot execute', async () => {
 const analysis = ['sources_list','sources_describe','sources_query','sources_read_result']
 for (const format of [undefined,'docx','xlsx','pptx','pdf']) {
  const requests=[], sent=[]
  const client=await createAssistantClient({
   format, csrfToken:'c'.repeat(43),
   request:async(path,method,body)=>{
    if(path.endsWith('/catalog'))return {entries:[{id:'chat'}],defaultId:'chat',sourceMode:'read-only-analysis'}
    requests.push({path,method,body});return {metadata:null}
   },
   fetchImpl:async(_url,init)=>{
    sent.push(JSON.parse(init.body).request)
    return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
   },
  })
  const skills=client.extraSkills
  assert.deepEqual(skills.flatMap(skill=>skill.tools.map(tool=>tool.name)),analysis)
  const tools=[...skills.flatMap(skill=>skill.tools),{name:'sources_save_result',description:'Save',inputSchema:{}}]
  await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'List tables'}],tools},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
  assert.deepEqual(sent[0].tools.map(tool=>tool.name),analysis)
  assert.deepEqual([...scopeAssistantRequest(sent[0],new Set(analysis)).tools],analysis)
  assert.deepEqual([...scopeAssistantRequest(sent[0],new Set(['sources_list'])).tools],['sources_list'])
  assert.deepEqual([...scopeAssistantRequest(sent[0],new Set()).tools],[])
  const skill=skills.find(skill=>skill.tools.some(tool=>tool.name==='sources_describe'))
  const call={id:'1',name:'sources_describe',input:{sourceId:'sales'}}
  assert.equal((await skill.executeTool(call)).isError,false)
  assert.deepEqual(requests,[{path:'/api/v1/ai/sources/execute',method:'POST',body:{name:'sources.describe',arguments:{sourceId:'sales'}}}])
  assert.equal((await skill.executeTool({...call,name:'sources_save_result'})).isError,true)
  client.dispose()
  assert.equal((await skill.executeTool(call)).isError,true)
  assert.equal(requests.length,1)
 }
})
