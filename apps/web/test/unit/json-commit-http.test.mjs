import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID,createHash} from 'node:crypto'
import {createSessionFileHost} from '../../../../packages/browser-host/src/session-files.ts'

// Real HTTP body/EOF behavior plus the production session host. Persistence here
// is a synthetic idempotent receipt map, not the PostgreSQL File API or Chromium.
for(const cut of [false,true])test(`JSON commit ${cut?'interruption preserves unknown for exact replay':'completes only after EOF without premature cancellation'}`,{timeout:15000},async t=>{
 const fileId=randomUUID(),editorId=randomUUID(),uploadId=randomUUID(),bytes=new Uint8Array([1,2,3])
 const ref={fileId,revision:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length},saved={...ref,revision:randomUUID()}
 const gate=Promise.withResolvers(),headers=Promise.withResolvers(),keys=[],premature=[];let commits=0
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk)
  const body=JSON.parse(Buffer.concat(chunks).toString());keys.push(body.idempotencyKey);commits++
  res.on('close',()=>premature.push(!res.writableFinished))
  res.writeHead(200,{'content-type':'application/json'})
  const json=JSON.stringify(saved)
  if(commits===1){res.write(json.slice(0,10));headers.resolve();await gate.promise;if(cut){res.destroy();return}res.end(json.slice(10))}else res.end(json)
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`
 t.after(async()=>{gate.resolve();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 const capabilities={docx:'editable',xlsx:'editable',pptx:'read_only',pdf:'read_only'}
 const host=createSessionFileHost({editorId,fetchImpl:async(path,init={})=>{
  if(path.endsWith('/commits'))return fetch(origin+path,init)
  if(path.endsWith('/csrf'))return Response.json({csrfToken:'a'.repeat(43)})
  if(path===`/api/v1/files/${fileId}`)return Response.json({file:ref,format:'docx',name:'synthetic.docx',capabilities,downloadEndpoint:`/api/v1/files/${fileId}/content?revision=${ref.revision}`})
  if(path.includes('/lease'))return Response.json({editorId,leaseEpoch:1,expiresAt:new Date(Date.now()+60000).toISOString()})
  if(path.endsWith('/uploads'))return Response.json({uploadId})
  if(path.endsWith('/content'))return new Response(null,{status:204})
  throw Error('Unexpected synthetic request')
 }})
 t.after(()=>host.dispose());await host.open(fileId);await host.acquireLease(fileId)
 let settled=false
 const saving=host.save(fileId,bytes);void saving.then(()=>settled=true,()=>settled=true)
 await headers.promise;assert.equal(settled,false);assert.equal(host.getState(fileId).status,'saving');assert.equal(commits,1);gate.resolve()
 if(cut){await assert.rejects(saving);assert.equal(host.getState(fileId).status,'unknown');assert.equal(host.getState(fileId).revision.revision,ref.revision);const recovered=await host.reconcile(fileId);assert.equal(recovered.revision,saved.revision);assert.equal(keys.length,2);assert.equal(new Set(keys).size,1)}
 else {assert.equal((await saving).revision,saved.revision);assert.deepEqual(premature,[false]);assert.equal(keys.length,1)}
 assert.equal(host.getState(fileId).status,'idle');assert.equal(host.getState(fileId).revision.revision,saved.revision)
})
