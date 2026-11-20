import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfMutations} from '../../src/editors/pdf-mutations.ts'

test('mixed PDF save snapshots its input once and recovers an unknown commit without a second preparation',async()=>{
 const calls=[];let grant,lose=true,revision='rev1'
 const snapshot={fileId:'file',baseRevision:revision,generation:1,metadata:{title:'Original'},rotations:{0:90}}
 const request=async(path,method,body)=>{
  calls.push([path,method,body])
  if(path.endsWith('/lease')&&method==='POST'){await new Promise(resolve=>grant=resolve);return {leaseEpoch:7}}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'file',uploadId:'upload',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits')){if(lose){lose=false;throw Error('response lost')}return {fileId:'file',revision:'rev2'}}
 }
 const client=createPdfMutations({fileId:'file',request,getRevision:()=>revision,onSaved:async receipt=>{revision=receipt.revision}})
 const pending=client.mutate('apply-ops',[snapshot])
 await new Promise(resolve=>setImmediate(resolve));snapshot.metadata.title='Changed during lease';grant()
 await assert.rejects(pending,/response lost/)
 const prepare=calls.find(call=>call[0].endsWith('/pdf/apply-ops/uploads'))
 assert.equal(prepare[2].snapshot.metadata.title,'Original');assert.equal(Object.hasOwn(prepare[2],'operations'),false)
 assert.equal(client.hasPending(),true);assert.equal(await client.confirm(),true)
 assert.equal(calls.filter(call=>call[0].endsWith('/uploads')).length,1)
 const commits=calls.filter(call=>call[0].endsWith('/commits'));assert.equal(commits.length,2);assert.deepEqual(commits[0][2],commits[1][2]);assert.equal(revision,'rev2')
 const count=calls.length
 assert.equal(await client.mutate('apply-ops',[snapshot]),false)
 assert.equal(await client.mutate('apply-ops',[]),false)
 assert.equal(calls.length,count)
})

test('PDF mutations await new revision application and retain the exact commit for lost-response recovery',async()=>{
 const calls=[];let revision='rev1',lose=true
 const request=async(path,method,body)=>{
  calls.push([path,method,body])
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'file',uploadId:'upload',baseRevision:revision,leaseEpoch:7,idempotencyKey:'one-key'}}
  if(path.endsWith('/commits')){if(lose){lose=false;throw Error('response lost')}return {fileId:'file',revision:'rev2'}}
 }
 const client=createPdfMutations({fileId:'file',request,getRevision:()=>revision,onSaved:async receipt=>{await Promise.resolve();revision=receipt.revision}})
 await assert.rejects(client.mutate('annotate',[{page:1,text:'Body',type:'note',contents:'Review'}]),/response lost/)
 assert.equal(client.hasPending(),true)
 assert.equal(await client.mutate('annotate',[]),false)
 await client.confirm()
 assert.equal(client.hasPending(),false)
 const commits=calls.filter(call=>call[0].endsWith('/commits'))
 assert.deepEqual(commits[0][2],commits[1][2])
 await client.mutate('edit-text',[{page:1,oldText:'Old',newText:'New'}])
 assert.equal(calls.filter(call=>call[0].endsWith('/pdf/edit-text/uploads'))[0][2].baseRevision,'rev2')
})

test('canceling after PDF preparation discards the staged upload without committing it',async()=>{
 const calls=[],controller=new AbortController()
 const request=async(path,method,body)=>{
  calls.push([path,method])
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/uploads')){
   controller.abort()
   return {commitInput:{fileId:'file',uploadId:'upload',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  }
 }
 const client=createPdfMutations({fileId:'file',request,getRevision:()=> 'rev1',onSaved:async()=>assert.fail('Canceled bytes must not be published')})
 await assert.rejects(client.mutate('edit-text',[],controller.signal),{name:'AbortError'})
 assert.equal(client.hasPending(),false)
 assert.equal(calls.some(call=>call[0].endsWith('/commits')),false)
 assert.ok(calls.some(call=>call[0]==='/api/v1/uploads/upload'&&call[1]==='DELETE'))
})

for(const status of [400,409])test(`a definitive initial PDF commit ${status} releases its preparation and permits another edit`,async()=>{
 const calls=[];let fail=true
 const request=async(path,method,body)=>{
  calls.push([path,method,body])
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'file',uploadId:'upload',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits')){
   if(fail){fail=false;throw Object.assign(Error('rejected'),{status})}
   return {fileId:'file',revision:'rev2'}
  }
 }
 const client=createPdfMutations({fileId:'file',request,getRevision:()=> 'rev1',onSaved:async()=>{}})
 await assert.rejects(client.mutate('edit-text',[]),{status})
 assert.equal(client.hasPending(),false)
 assert.ok(calls.some(call=>call[0]==='/api/v1/uploads/upload'&&call[1]==='DELETE'))
 assert.equal(calls.filter(call=>call[0].endsWith('/lease')&&call[1]==='DELETE').length,1)
 assert.equal(await client.mutate('annotate',[]),true)
})

test('a receipt-checked 409 resolves an unknown PDF commit as rejected and unlocks editing',async()=>{
 const calls=[];let attempt=0
 const request=async(path,method,body)=>{
  calls.push([path,method,body])
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'file',uploadId:'upload',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits')){
   attempt++
   if(attempt===1)throw Error('response lost')
   if(attempt===2)throw Object.assign(Error('conflict'),{status:409})
   return {fileId:'file',revision:'rev2'}
  }
 }
 const client=createPdfMutations({fileId:'file',request,getRevision:()=> 'rev1',onSaved:async()=>{}})
 await assert.rejects(client.mutate('edit-text',[]),/response lost/)
 await assert.rejects(client.confirm(),{status:409})
 assert.equal(client.hasPending(),false)
 assert.ok(calls.some(call=>call[0]==='/api/v1/uploads/upload'&&call[1]==='DELETE'))
 assert.equal(calls.filter(call=>call[0].endsWith('/lease')&&call[1]==='DELETE').length,1)
 assert.equal(await client.mutate('annotate',[]),true)
})

for(const status of [401,403,404,408,429,500])test(`PDF unknown recovery ${status} retains the exact commit and can still confirm success`,async()=>{
 const commits=[];let attempt=0
 const request=async(path,method,body)=>{
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'file',uploadId:'upload',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits')){
   commits.push(body);attempt++
   if(attempt===1)throw Error('response lost')
   if(attempt===2)throw Object.assign(Error('unconfirmed'),{status})
   return {fileId:'file',revision:'rev2'}
  }
  if(method==='DELETE'&&path.startsWith('/api/v1/uploads/'))assert.fail('An unknown commit must not be discarded')
 }
 const client=createPdfMutations({fileId:'file',request,getRevision:()=> 'rev1',onSaved:async()=>{}})
 await assert.rejects(client.mutate('edit-text',[]),/response lost/)
 await assert.rejects(client.confirm(),{status})
 assert.equal(client.hasPending(),true)
 assert.equal(await client.mutate('annotate',[]),false)
 assert.equal(await client.confirm(),true)
 assert.deepEqual(commits[0],commits[1])
 assert.deepEqual(commits[1],commits[2])
})

for(const status of [408,429,500])test(`an initial PDF commit ${status} remains recoverable`,async()=>{
 const request=async(path,method,body)=>{
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'file',uploadId:'upload',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits'))throw Object.assign(Error('unconfirmed'),{status})
  if(method==='DELETE')assert.fail('An unknown commit must keep its upload and lease')
 }
 const client=createPdfMutations({fileId:'file',request,getRevision:()=> 'rev1',onSaved:async()=>{}})
 await assert.rejects(client.mutate('edit-text',[]),{status})
 assert.equal(client.hasPending(),true)
})

test('note updates stage the exact operation, forward cancellation and await the committed revision refresh',async()=>{
 const calls=[],controller=new AbortController(),refresh=Promise.withResolvers(),started=Promise.withResolvers()
 const operation={page:1,annotationId:'7R',action:'reply',text:'AI reply'}
 const client=createPdfMutations({fileId:'file',getRevision:()=> 'rev1',request:async(path,method,body,signal)=>{
  calls.push({path,method,body,signal})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/update-notes/uploads'))return {commitInput:{fileId:'file',uploadId:'upload',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits'))return {fileId:'file',revision:'rev2'}
 },onSaved:async receipt=>{assert.deepEqual(receipt,{fileId:'file',revision:'rev2'});started.resolve();await refresh.promise}})
 let saved=false
 const pending=client.mutate('update-notes',[operation],controller.signal).then(value=>{saved=value})
 await started.promise
 assert.equal(saved,false)
 assert.deepEqual(calls.find(call=>call.path.endsWith('/update-notes/uploads')).body.operations,[operation])
 assert.ok(calls.filter(call=>call.method==='POST').every(call=>call.signal===controller.signal))
 refresh.resolve();await pending;assert.equal(saved,true)
})

test('form value batches use staged revision commits and recover the original exact commit after a lost response',async()=>{
 const calls=[],saved=[];let lose=true
 const operations=[{op:'setFormValue',value:{name:'Customer',value:'Alice'}}]
 const request=async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/form-values/uploads'))return {commitInput:{fileId:'file',uploadId:'forms',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits')){if(lose){lose=false;throw Error('response lost')}return {fileId:'file',revision:'rev2'}}
 }
 const client=createPdfMutations({fileId:'file',request,getRevision:()=> 'rev1',onSaved:async receipt=>saved.push(receipt)})
 await assert.rejects(client.mutate('form-values',operations),/response lost/)
 assert.equal(client.hasPending(),true)
 assert.equal(await client.mutate('form-values',operations),false)
 assert.equal(await client.confirm(),true)
 const stages=calls.filter(call=>call.path.endsWith('/form-values/uploads'))
 assert.equal(stages.length,1);assert.deepEqual(stages[0].body.operations,operations)
 const commits=calls.filter(call=>call.path.endsWith('/commits'));assert.deepEqual(commits[0].body,commits[1].body)
 assert.deepEqual(saved,[{fileId:'file',revision:'rev2'}])
})

for(const status of [401,403,404,410,415,422])test(`initial PDF commit ${status} retains its exact input for confirmation without preparing or deleting another upload`,async()=>{
 const calls=[],saved=[];let first=true
 const client=createPdfMutations({fileId:'file',getRevision:()=> 'rev1',onSaved:async receipt=>saved.push(receipt),request:async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/uploads'))return {commitInput:{fileId:'file',uploadId:'original',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits')){if(first){first=false;throw Object.assign(Error('post-response authority unavailable'),{status})}return {fileId:'file',revision:'rev2'}}
 }})
 await assert.rejects(client.mutate('form-values',[{op:'setFormValue',value:{name:'Name',value:'Alice'}}]),{status})
 assert.equal(client.hasPending(),true)
 assert.equal(await client.mutate('form-values',[]),false)
 assert.equal(calls.some(call=>call.method==='DELETE'),false)
 assert.equal(await client.confirm(),true)
 assert.equal(calls.filter(call=>call.path.endsWith('/form-values/uploads')).length,1)
 const commits=calls.filter(call=>call.path.endsWith('/commits'));assert.equal(commits.length,2);assert.deepEqual(commits[0].body,commits[1].body)
 assert.equal(calls.some(call=>call.method==='DELETE'&&call.path.includes('/uploads/')),false)
 assert.deepEqual(saved,[{fileId:'file',revision:'rev2'}])
})

test('single-image content stages one operation and recovers the same commit without downloading or staging twice',async()=>{
 const calls=[];let lose=true
 const operation={op:'insert_image',page:1,image:{mime:'image/png',base64:'iVBORw0KGgo='}}
 const client=createPdfMutations({fileId:'file',getRevision:()=> 'rev1',onSaved:async()=>{},request:async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/image-content/uploads'))return {commitInput:{fileId:'file',uploadId:'image',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits')){if(lose){lose=false;throw Error('response lost')}return {fileId:'file',revision:'rev2'}}
 }})
 await assert.rejects(client.mutate('image-content',[operation]),/response lost/)
 assert.equal(client.hasPending(),true)
 assert.equal(await client.confirm(),true)
 const stages=calls.filter(call=>call.path.endsWith('/image-content/uploads'))
 assert.equal(stages.length,1);assert.deepEqual(stages[0].body.operation,operation);assert.equal('operations' in stages[0].body,false)
 const commits=calls.filter(call=>call.path.endsWith('/commits'));assert.deepEqual(commits[0].body,commits[1].body)
})

test('image pixel bakes stage one source operation, reject batches and preserve unknown commits',async()=>{
 const calls=[];let lose=true
 const operation={op:'crop_image',page:1,image_number:1,left:.25}
 const client=createPdfMutations({fileId:'file',getRevision:()=> 'rev1',onSaved:async()=>{},request:async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:7}
  if(path.endsWith('/image-bakes/uploads'))return {commitInput:{fileId:'file',uploadId:'bake',baseRevision:'rev1',leaseEpoch:7,idempotencyKey:body.idempotencyKey}}
  if(path.endsWith('/commits')){if(lose){lose=false;throw Error('response lost')}return {fileId:'file',revision:'rev2'}}
 }})
 assert.equal(await client.mutate('image-bakes',[]),false)
 assert.equal(await client.mutate('image-bakes',[operation,operation]),false)
 assert.equal(calls.length,0)
 await assert.rejects(client.mutate('image-bakes',[operation]),/response lost/)
 assert.equal(client.hasPending(),true)
 assert.equal(await client.mutate('image-bakes',[operation]),false)
 assert.equal(await client.confirm(),true)
 const stages=calls.filter(call=>call.path.endsWith('/image-bakes/uploads'))
 assert.equal(stages.length,1);assert.deepEqual(stages[0].body.operation,operation);assert.equal('operations' in stages[0].body,false)
 const commits=calls.filter(call=>call.path.endsWith('/commits'));assert.deepEqual(commits[0].body,commits[1].body)
})
