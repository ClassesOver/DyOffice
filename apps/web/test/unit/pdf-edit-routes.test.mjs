import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {request as httpRequest} from 'node:http'
import {registerPdfRoutes} from '../../server/src/modules/pdf/routes.ts'

test('PDF original text edits require a session, CSRF and a revision-bound operation',async t=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false,useDefaults:false}}})
 t.after(()=>app.close())
 const token='a'.repeat(43),fileId='74ad6054-8061-44ef-b42c-ef55e5bf851d',revision='4746fb72-4380-4d28-9802-86fa3b462807',calls=[]
 const sessions={async authenticate(value){if(value!==token)throw Object.assign(Error('unauthorized'),{statusCode:401})}}
 const csrf={originCheck(){},requireSession(request,value){if(value!==token||request.headers['x-csrf-token']!==token)throw Object.assign(Error('csrf'),{statusCode:403})}}
 const pdf={async queryImageInserts(...args){calls.push(args);return {revision,image:{}}},async queryDraftInserts(...args){calls.push(args);return {revision,pages:[]}},async stageDraftInserts(...args){calls.push(args);return {commitInput:{fileId,revision}}},async queryTextInserts(...args){calls.push(args);return {revision,blocks:[]}},async queryRedactions(...args){calls.push(args);return {revision,candidates:[],truncated:false,scannedPages:[],unsupportedPages:[]}},async stageRedactedCopy(...args){calls.push(args);return {uploadId:fileId,fileId:revision,sha256:"a".repeat(64),size:100}},async stageReplacePages(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stageStamps(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stageImageBakes(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stageImageContent(...args){calls.push(args);return {commitInput:{fileId,revision}}},async queryImages(...args){calls.push(args);return {revision,images:[]}},async stageImageEdits(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stageBlockMoves(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stageBlockEdits(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stageTextInserts(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stageFormValues(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stagePageLayout(...args){calls.push(args);return {uploadId:fileId,fileId:revision,sha256:"a".repeat(64),size:100}},async stageSplit(...args){calls.push(args);return {files:[{uploadId:fileId,fileId:revision,sha256:"a".repeat(64),size:100}]}},async stageExtractPages(...args){calls.push(args);return {uploadId:fileId,fileId:revision,sha256:"a".repeat(64),size:100}},async stagePageOps(...args){calls.push(args);return {commitInput:{fileId,revision}}},async pageOpsAndCommit(...args){calls.push(args);return {fileId,revision}},async stageUpdateNotes(...args){calls.push(args);return {commitInput:{fileId,revision}}},async updateNotesAndCommit(...args){calls.push(args);return {fileId,revision}},async editTextAndCommit(...args){calls.push(args);return {fileId,revision}},async annotateAndCommit(...args){calls.push(args);return {fileId,revision}},async stageTextEdit(...args){calls.push(args);return {commitInput:{fileId,revision}}},async stageAnnotate(...args){calls.push(args);return {commitInput:{fileId,revision}}},async deleteAnnotationsAndCommit(...args){calls.push(args);return {fileId,revision}},async stageDeleteAnnotations(...args){calls.push(args);return {commitInput:{fileId,revision}}}}
 registerPdfRoutes(app,pdf,sessions,csrf)
 const url=`/api/v1/files/${fileId}/pdf/edit-text`,headers={cookie:`__Host-dyoffice-session=${token}`,'x-csrf-token':token}
 const payload={baseRevision:revision,editorId:fileId,leaseEpoch:1,idempotencyKey:'edit-text-1',operations:[{page:1,oldText:'Old',newText:'New',occurrence:1}]}
 assert.equal((await app.inject({method:'POST',url,payload})).statusCode,403)
 assert.equal((await app.inject({method:'POST',url,headers,payload})).statusCode,200)
 assert.deepEqual(calls.map(call=>call.slice(0,3)),[[token,fileId,payload]])
 assert.ok(calls[0][3] instanceof AbortSignal)
 for(const operations of [[{page:1,oldText:'',newText:'New'}],[{page:0,oldText:'Old',newText:'New'}],[{page:1,oldText:'Old',newText:'New',rect:[0,0,10,10]}]]){
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,operations}})).statusCode,400)
 }
 assert.equal(calls.length,1)
 const annotation={...payload,operations:[{page:1,text:'Old',type:'note',contents:'Review this.'}]}
 assert.equal((await app.inject({method:'POST',url:`/api/v1/files/${fileId}/pdf/annotate`,headers,payload:annotation})).statusCode,200)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,annotation])
 assert.equal((await app.inject({method:'POST',url:url+'/uploads',headers,payload})).statusCode,200)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,payload])
 assert.equal((await app.inject({method:'POST',url:`/api/v1/files/${fileId}/pdf/annotate/uploads`,headers,payload:annotation})).statusCode,200)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,annotation])
 const deletion={...payload,operations:[{page:1,annotationId:'7R'}]}
 for(const suffix of ['','/uploads']){
  const deleteUrl=`/api/v1/files/${fileId}/pdf/delete-annotations${suffix}`
  assert.equal((await app.inject({method:'POST',url:deleteUrl,payload:deletion})).statusCode,403)
  assert.equal((await app.inject({method:'POST',url:deleteUrl,headers,payload:deletion})).statusCode,200)
  assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,deletion])
  assert.ok(calls.at(-1)[3] instanceof AbortSignal)
  for(const operations of [[{page:1,annotationId:'annot_p0_1'}],[{page:0,annotationId:'7R'}],[{page:1,annotationId:'7R',path:'/tmp/a'}]])assert.equal((await app.inject({method:'POST',url:deleteUrl,headers,payload:{...deletion,operations}})).statusCode,400)
 }
 const update={...payload,operations:[{page:1,annotationId:'7R2',action:'reply',text:'AI reply'}]}
 for(const suffix of ['','/uploads']){
  const updateUrl=`/api/v1/files/${fileId}/pdf/update-notes${suffix}`
  assert.equal((await app.inject({method:'POST',url:updateUrl,payload:update})).statusCode,403)
  assert.equal((await app.inject({method:'POST',url:updateUrl,headers,payload:update})).statusCode,200)
  assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,update])
  assert.ok(calls.at(-1)[3] instanceof AbortSignal)
  for(const operations of [[{page:1,annotationId:'annot_p0_1',action:'reply',text:'x'}],[{page:1,annotationId:'7R2',action:'delete',text:'x'}],[{page:1,annotationId:'7R2',action:'edit',text:''}],[{page:1,annotationId:'7R2',action:'edit',text:'x',author:'Other'}]])assert.equal((await app.inject({method:'POST',url:updateUrl,headers,payload:{...update,operations}})).statusCode,400)
 }

 const queryUrl=`/api/v1/files/${fileId}/pdf/images/query`
 assert.equal((await app.inject({method:'POST',url:queryUrl,payload:{revision}})).statusCode,403)
 const queryResponse=await app.inject({method:'POST',url:queryUrl,headers,payload:{revision}});assert.equal(queryResponse.statusCode,200,queryResponse.body);assert.deepEqual(queryResponse.json(),{revision,images:[]})
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,{revision}]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 assert.equal((await app.inject({method:'POST',url:queryUrl,headers,payload:{revision,path:'/tmp/private'}})).statusCode,400)
 const images={...payload,operations:[{op:'transform_image',page:1,image_number:1,x:30,width:150,layer:'below_text'},{op:'rotate_image',page:1,image_number:2,direction:'ccw'},{op:'delete_image',page:1,image_number:3}]},imagesUrl=`/api/v1/files/${fileId}/pdf/image-edits/uploads`
 assert.equal((await app.inject({method:'POST',url:imagesUrl,payload:images})).statusCode,403)
 const imagesResponse=await app.inject({method:'POST',url:imagesUrl,headers,payload:images});assert.equal(imagesResponse.statusCode,200,imagesResponse.body)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,images]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 for(const operation of [{op:'transform_image',page:1,image_number:1,width:0},{op:'delete_image',page:1,image_number:1,image:'url'},{op:'rotate_image',page:1,image_number:1,direction:'45'},{op:'transform_image',page:1,image_number:1,x:'10'}])assert.equal((await app.inject({method:'POST',url:imagesUrl,headers,payload:{...images,operations:[operation]}})).statusCode,400)

 const {operations:unusedBakeOperations,...bakeBase}=payload
 const bakesUrl=`/api/v1/files/${fileId}/pdf/image-bakes/uploads`
 for(const operation of [{op:'flip_image',page:1,image_number:1,axis:'horizontal'},{op:'set_image_opacity',page:1,image_number:1,opacity:0},{op:'crop_image',page:1,image_number:1,left:.2},{op:'remove_image_background',page:1,image_number:1}]){
  const baked={...bakeBase,operation};assert.equal((await app.inject({method:'POST',url:bakesUrl,payload:baked})).statusCode,403)
  const response=await app.inject({method:'POST',url:bakesUrl,headers,payload:baked});assert.equal(response.statusCode,200,response.body);assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,baked]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 }
 for(const operation of [{op:'flip_image',page:1,image_number:1,axis:'diagonal'},{op:'set_image_opacity',page:1,image_number:1,opacity:1.1},{op:'crop_image',page:1,image_number:1,left:1},{op:'remove_image_background',page:1,image_number:1,tolerance:101},{op:'flip_image',page:1,image_number:1,axis:'horizontal',image:'fake'}])assert.equal((await app.inject({method:'POST',url:bakesUrl,headers,payload:{...bakeBase,operation}})).statusCode,400)

 const {operations:unusedContentOperations,...contentBase}=payload
 const content={...contentBase,operation:{op:'insert_image',page:1,image:{base64:'AAAA',mime:'image/png'},anchor_text:'Caption',placement:'below',width:80}},contentUrl=`/api/v1/files/${fileId}/pdf/image-content/uploads`
 assert.equal((await app.inject({method:'POST',url:contentUrl,payload:content})).statusCode,403)
 const contentResponse=await app.inject({method:'POST',url:contentUrl,headers,payload:content});assert.equal(contentResponse.statusCode,200,contentResponse.body)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,content]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 const replacement={...content,operation:{op:'replace_image',page:1,image_number:2,image:content.operation.image}};assert.equal((await app.inject({method:'POST',url:contentUrl,headers,payload:replacement})).statusCode,200)
 for(const operation of [{...content.operation,url:'https://example.com'},{...replacement.operation,width:20},{...content.operation,image:{base64:'AAAA',mime:'image/webp'}},{...content.operation,width:0}])assert.equal((await app.inject({method:'POST',url:contentUrl,headers,payload:{...content,operation}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:contentUrl,headers,payload:{...content,operations:[]}})).statusCode,400)
 const large={...content,operation:{...content.operation,image:{base64:'A'.repeat(1024*1024+4),mime:'image/png'}}};assert.equal((await app.inject({method:'POST',url:contentUrl,headers,payload:large})).statusCode,200)

 const moves={...payload,operations:[{page:1,paragraph_text:'Original paragraph',dx:20,dy:30}]},movesUrl=`/api/v1/files/${fileId}/pdf/block-moves/uploads`
 assert.equal((await app.inject({method:'POST',url:movesUrl,payload:moves})).statusCode,403)
 const moveResponse=await app.inject({method:'POST',url:movesUrl,headers,payload:moves});assert.equal(moveResponse.statusCode,200,moveResponse.body)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,moves]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 for(const patch of [{dx:'1'},{dy:100001},{page:101},{paragraph_text:''},{rect:[0,0,1,1]}])assert.equal((await app.inject({method:'POST',url:movesUrl,headers,payload:{...moves,operations:[{page:1,paragraph_text:'Original',dx:1,dy:1,...patch}]}})).statusCode,400)

 const blocks={...payload,operations:[{page:1,paragraph_text:'Original paragraph',new_text:'Rewritten paragraph',font_size:14,align:'center',font:'arial',bold:true,italic:false,color:'#123456'}]},blocksUrl=`/api/v1/files/${fileId}/pdf/block-edits/uploads`
 assert.equal((await app.inject({method:'POST',url:blocksUrl,payload:blocks})).statusCode,403)
 const blockResponse=await app.inject({method:'POST',url:blocksUrl,headers,payload:blocks});assert.equal(blockResponse.statusCode,200,blockResponse.body)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,blocks]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 assert.equal((await app.inject({method:'POST',url:blocksUrl,headers,payload:{...blocks,operations:[{page:1,paragraph_text:'Original',new_text:''}]}})).statusCode,200)
 for(const patch of [{font_size:0},{font_size:1001},{font:'unknown'},{align:'justify'},{page:101},{bold:'true'},{rect:[0,0,1,1]},{paragraph_text:''},{new_text:null}])assert.equal((await app.inject({method:'POST',url:blocksUrl,headers,payload:{...blocks,operations:[{page:1,paragraph_text:'Original',new_text:'x',...patch}]}})).statusCode,400)

 const inserts={...payload,operations:[{page:1,text:'张三',anchor_text:'Name:',placement:'right',font_size:14,max_width:100,align:'center',font:'arial',bold:true,italic:false,color:'#123456'}]},insertsUrl=`/api/v1/files/${fileId}/pdf/text-inserts/uploads`
 assert.equal((await app.inject({method:'POST',url:insertsUrl,payload:inserts})).statusCode,403)
 const insertResponse=await app.inject({method:'POST',url:insertsUrl,headers,payload:inserts});assert.equal(insertResponse.statusCode,200,insertResponse.body)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,inserts]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 for(const patch of [{font_size:0},{font_size:1001},{max_width:0},{font:'unknown'},{page:101},{x:'10'},{bold:'true'},{origin:[0,0]}])assert.equal((await app.inject({method:'POST',url:insertsUrl,headers,payload:{...inserts,operations:[{page:1,text:'x',...patch}]}})).statusCode,400)

 const draftImage={page:1,image:{base64:'AAAA',mime:'image/png'},x:10,y:20,width:40,height:80,layer:'below_text'},draftOperation={texts:[{page:1,text:'Draft'}],images:[draftImage]},draftQuery={revision,operation:draftOperation},draftUpload={baseRevision:revision,editorId:fileId,leaseEpoch:1,idempotencyKey:'draft-001',operation:draftOperation}
 for(const [suffix,body]of [['image-inserts/query',{revision,operation:draftImage}],['draft-inserts/query',draftQuery],['draft-inserts/uploads',draftUpload]]){
  const endpoint=`/api/v1/files/${fileId}/pdf/${suffix}`;assert.equal((await app.inject({method:'POST',url:endpoint,payload:body})).statusCode,403)
  const response=await app.inject({method:'POST',url:endpoint,headers,payload:body});assert.equal(response.statusCode,200,response.body);assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,body]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 }
 for(const patch of [{height:0},{width:0},{page:0},{unknown:1},{image:{base64:'AAAA',mime:'image/webp'}}])assert.equal((await app.inject({method:'POST',url:`/api/v1/files/${fileId}/pdf/image-inserts/query`,headers,payload:{revision,operation:{...draftImage,...patch}}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:`/api/v1/files/${fileId}/pdf/draft-inserts/uploads`,headers,payload:{...draftUpload,operation:{texts:[],images:Array(21).fill(draftImage)}}})).statusCode,400)

 const insertQueryUrl=`/api/v1/files/${fileId}/pdf/text-inserts/query`,insertPreview={revision,operations:[{page:1,text:'Draft',anchor_text:'Anchor',placement:'below',font_size:14,max_width:100,align:'right',bold:true}]}
 assert.equal((await app.inject({method:'POST',url:insertQueryUrl,payload:insertPreview})).statusCode,403)
 const insertQueryResponse=await app.inject({method:'POST',url:insertQueryUrl,headers,payload:insertPreview});assert.equal(insertQueryResponse.statusCode,200,insertQueryResponse.body);assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,insertPreview]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 for(const patch of [{operations:[]},{operations:[{page:0,text:'x'}]},{operations:[{page:1,text:'x',font_size:0}]},{operations:[{page:1,text:'x',rect:[0,0,1,1]}]},{editorId:fileId}])assert.equal((await app.inject({method:'POST',url:insertQueryUrl,headers,payload:{...insertPreview,...patch}})).statusCode,400)

 const redactQueryUrl=`/api/v1/files/${fileId}/pdf/redactions/query`,copyUrl=`/api/v1/files/${fileId}/pdf/redacted-copy/uploads`,queryRedactions={revision,patterns:['email']},copyRedactions={baseRevision:revision,editorId:fileId,leaseEpoch:1,patterns:['email'],ids:['a'.repeat(64)],name:'涂黑副本.pdf'}
 for(const [endpoint,body]of [[redactQueryUrl,queryRedactions],[copyUrl,copyRedactions]]){
  assert.equal((await app.inject({method:'POST',url:endpoint,payload:body})).statusCode,403)
  const response=await app.inject({method:'POST',url:endpoint,headers,payload:body});assert.equal(response.statusCode,200,response.body)
  assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,body]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 }
 for(const patch of [{ids:[]},{ids:['bad']},{ids:['a'.repeat(64),'a'.repeat(64)]},{patterns:['unknown']},{name:'bad.docx'},{rect:[0,0,1,1]}])assert.equal((await app.inject({method:'POST',url:copyUrl,headers,payload:{...copyRedactions,...patch}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:redactQueryUrl,headers,payload:{...queryRedactions,patterns:[]}})).statusCode,400)

 const replaceQuery=new URLSearchParams({baseRevision:revision,editorId:fileId,leaseEpoch:'1',idempotencyKey:'replace-001',pages:'[3,1,1]'}),replaceUrl=`/api/v1/files/${fileId}/pdf/replace-pages/uploads?${replaceQuery}`,binary=Buffer.from('%PDF-source'),binaryHeaders={...headers,'content-type':'application/octet-stream'}
 assert.equal((await app.inject({method:'POST',url:replaceUrl,headers:{'content-type':'application/octet-stream'},payload:binary})).statusCode,403)
 const replaced=await app.inject({method:'POST',url:replaceUrl,headers:binaryHeaders,payload:binary});assert.equal(replaced.statusCode,200,replaced.body)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,{baseRevision:revision,editorId:fileId,leaseEpoch:1,idempotencyKey:'replace-001',pages:[3,1,1]}]);assert.deepEqual(calls.at(-1)[3],binary);assert.ok(calls.at(-1)[4] instanceof AbortSignal)
 for(const patch of [{pages:'bad'},{leaseEpoch:'0'},{leaseEpoch:'9007199254740999'},{extra:'x'}]){
  const query=new URLSearchParams({...Object.fromEntries(replaceQuery),...patch})
  assert.equal((await app.inject({method:'POST',url:`/api/v1/files/${fileId}/pdf/replace-pages/uploads?${query}`,headers:binaryHeaders,payload:binary})).statusCode,400)
 }
 const insertQuery=new URLSearchParams({baseRevision:revision,editorId:fileId,leaseEpoch:'1',idempotencyKey:'insert-001',afterPageIndex:'-1'}),insertUrl=`/api/v1/files/${fileId}/pdf/insert-pages/uploads?${insertQuery}`
 const inserted=await app.inject({method:'POST',url:insertUrl,headers:binaryHeaders,payload:binary});assert.equal(inserted.statusCode,200,inserted.body)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,{baseRevision:revision,editorId:fileId,leaseEpoch:1,idempotencyKey:'insert-001',afterPageIndex:-1}]);assert.deepEqual(calls.at(-1)[3],binary)
 for(const patch of [{afterPageIndex:'100'},{afterPageIndex:'1.5'},{leaseEpoch:'0'},{extra:'x'}]){
  const query=new URLSearchParams({...Object.fromEntries(insertQuery),...patch})
  assert.equal((await app.inject({method:'POST',url:`/api/v1/files/${fileId}/pdf/insert-pages/uploads?${query}`,headers:binaryHeaders,payload:binary})).statusCode,400)
 }
 assert.equal((await app.inject({method:'POST',url:replaceUrl,headers,payload:{source:'base64'}})).statusCode,400)

 const stampUrl=`/api/v1/files/${fileId}/pdf/stamps/uploads`
 for(const operation of [{op:'set_watermark',text:'内部草稿',angle:35,opacity:.18,color:'#d0342c',size:.11},{op:'set_watermark',text:''},{op:'set_header_footer',header_left:'第{page}页',page_number:true,start_at:0,font_size:9},{op:'set_header_footer'}]){
  const stamp={baseRevision:revision,editorId:fileId,leaseEpoch:1,idempotencyKey:'stamp-001',operation}
  assert.equal((await app.inject({method:'POST',url:stampUrl,payload:stamp})).statusCode,403)
  const result=await app.inject({method:'POST',url:stampUrl,headers,payload:stamp});assert.equal(result.statusCode,200,result.body)
  assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,stamp]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 }
 for(const operation of [{op:'set_watermark',text:'x',angle:181},{op:'set_watermark',text:'x',opacity:2},{op:'set_watermark',text:'x',size:0},{op:'set_watermark',text:'x',path:'/tmp/x'},{op:'set_header_footer',start_at:1.5},{op:'set_header_footer',page_number:'true'},{op:'set_header_footer',font_size:3}])assert.equal((await app.inject({method:'POST',url:stampUrl,headers,payload:{baseRevision:revision,editorId:fileId,leaseEpoch:1,operation}})).statusCode,400)

 const forms={...payload,operations:[{op:'setFormValue',value:{name:'Name',value:'张三'}},{op:'setFormValue',value:{name:'Consent',checked:true}}]},formsUrl=`/api/v1/files/${fileId}/pdf/form-values/uploads`
 assert.equal((await app.inject({method:'POST',url:formsUrl,payload:forms})).statusCode,403)
 const formResponse=await app.inject({method:'POST',url:formsUrl,headers,payload:forms});assert.equal(formResponse.statusCode,200,formResponse.body)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,forms]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 for(const value of [{name:'Name',kind:'text',value:'x'},{name:'Consent',checked:'false'},{name:'Name',value:'x',checked:true},{name:'Name'}])assert.equal((await app.inject({method:'POST',url:formsUrl,headers,payload:{...forms,operations:[{op:'setFormValue',value}]}})).statusCode,400)

 const pageOps={...payload,operations:[{op:'rotatePages',pages:[1],dir:90},{op:'deletePage',page:2},{op:'setPageOrder',order:[3,1]},{op:'insertBlankPage',afterPage:0}]}
 for(const suffix of ['','/uploads']){
  const pageUrl=`/api/v1/files/${fileId}/pdf/page-ops${suffix}`
  assert.equal((await app.inject({method:'POST',url:pageUrl,payload:pageOps})).statusCode,403)
  assert.equal((await app.inject({method:'POST',url:pageUrl,headers,payload:pageOps})).statusCode,200)
  assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,pageOps]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
  for(const operation of [{op:'setPageSize',width:595,height:842},{op:'cropPages',pages:[1],left:0.1,top:0.2,right:0.9,bottom:0.8}]){
   const geometry={...pageOps,operations:[operation]}
   assert.equal((await app.inject({method:'POST',url:pageUrl,headers,payload:geometry})).statusCode,200)
   assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,geometry])
  }
  for(const operations of [[{op:'setPageSize',width:0,height:842}],[{op:'cropPages',pages:[1],left:-0.1,top:0,right:1,bottom:1}],[{op:'deletePage',page:0}],[{op:'rotatePages',pages:[1,1],dir:90}],[{op:'setPageOrder',order:[1,1]}],[{op:'insertBlankPage',afterPage:-1}],[{op:'deletePage',page:1,path:'/tmp/x'}]])assert.equal((await app.inject({method:'POST',url:pageUrl,headers,payload:{...pageOps,operations}})).statusCode,400)
 }

 const extract={baseRevision:revision,editorId:fileId,leaseEpoch:1,pages:[3,1],name:'Selected.pdf'},extractUrl=`/api/v1/files/${fileId}/pdf/extract-pages/uploads`
 assert.equal((await app.inject({method:'POST',url:extractUrl,payload:extract})).statusCode,403)
 const response=await app.inject({method:'POST',url:extractUrl,headers,payload:extract})
 assert.equal(response.statusCode,200,response.body);assert.equal(response.json().uploadId,fileId)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,extract]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 for(const patch of [{pages:[]},{pages:[1,1]},{pages:[0]},{name:'Wrong.docx'},{path:'/tmp/a'}])assert.equal((await app.inject({method:'POST',url:extractUrl,headers,payload:{...extract,...patch}})).statusCode,400)

 const split={baseRevision:revision,editorId:fileId,leaseEpoch:1,pagesPerFile:2},splitUrl=`/api/v1/files/${fileId}/pdf/split/uploads`
 assert.equal((await app.inject({method:'POST',url:splitUrl,payload:split})).statusCode,403)
 const splitResponse=await app.inject({method:'POST',url:splitUrl,headers,payload:split})
 assert.equal(splitResponse.statusCode,200,splitResponse.body);assert.equal(splitResponse.json().files[0].uploadId,fileId)
 assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,split]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 for(const patch of [{pagesPerFile:0},{pagesPerFile:1.5},{pagesPerFile:101},{pagesPerFile:'2'},{path:'/tmp/a'}])assert.equal((await app.inject({method:'POST',url:splitUrl,headers,payload:{...split,...patch}})).statusCode,400)

 const layoutUrl=`/api/v1/files/${fileId}/pdf/page-layout/uploads`
 for(const operation of [{kind:'split',perPage:2},{kind:'merge',perSheet:4,direction:'vertical',separator:true}]){
  const layout={baseRevision:revision,editorId:fileId,leaseEpoch:1,operation}
  assert.equal((await app.inject({method:'POST',url:layoutUrl,payload:layout})).statusCode,403)
  const result=await app.inject({method:'POST',url:layoutUrl,headers,payload:layout});assert.equal(result.statusCode,200,result.body)
  assert.deepEqual(calls.at(-1).slice(0,3),[token,fileId,layout]);assert.ok(calls.at(-1)[3] instanceof AbortSignal)
 }
 for(const operation of [{kind:'split',perPage:3},{kind:'merge',perSheet:17,direction:'horizontal',separator:false},{kind:'merge',perSheet:2,direction:'vertical',separator:'true'},{kind:'split',perPage:2,path:'/tmp/a'}])assert.equal((await app.inject({method:'POST',url:layoutUrl,headers,payload:{baseRevision:revision,editorId:fileId,leaseEpoch:1,operation}})).statusCode,400)

})

test('PDF route disconnect aborts the service operation before it can publish', {timeout:5000}, async t=>{
 const app=Fastify(),fileId='74ad6054-8061-44ef-b42c-ef55e5bf851d'
 let started,finish,signal
 const running=new Promise(resolve=>{started=resolve})
 registerPdfRoutes(app,{async stageTextEdit(_token,_id,_body,current){signal=current;started();return new Promise(resolve=>{finish=resolve})}},{async authenticate(){}},{originCheck(){},requireSession(){}})
 await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close())
 const payload=JSON.stringify({baseRevision:fileId,editorId:fileId,leaseEpoch:1,operations:[{page:1,oldText:'Old',newText:'New'}]})
 const req=httpRequest({host:'127.0.0.1',port:app.server.address().port,path:`/api/v1/files/${fileId}/pdf/edit-text/uploads`,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}})
 req.on('error',()=>{});req.end(payload)
 try{
  await running;req.destroy();await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(signal?.aborted,true)
 }finally{finish?.({});req.destroy()}
})
