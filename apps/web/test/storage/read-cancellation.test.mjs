import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createLocalObjectStore} from '../../server/src/storage/local-dev.ts'
import {createS3ObjectStore} from '../../server/src/storage/s3.ts'
const key=()=>[randomUUID(),randomUUID(),'objects',randomUUID()].join('/')
test('local verified read refuses an already-cancelled background read',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-read-abort-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 const store=await createLocalObjectStore({directory}),reference=await store.putImmutable(key(),Buffer.from('private document'))
 await assert.rejects(store.readVerified(reference,AbortSignal.abort()))
 assert.equal((await store.readVerified(reference)).toString(),'private document')
})
test('cancelling an S3 verified read aborts its request signal and closes an unfinished body',{timeout:2000},async()=>{
 const controller=new AbortController(),bytes=Buffer.from('private document'),body=new Readable({read(){}})
 const reference={key:key(),sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}
 let requestSignal,entered
 const started=new Promise(resolve=>{entered=resolve})
 const store=createS3ObjectStore({bucket:'background-test',client:{send:async(_command,options)=>{requestSignal=options.abortSignal;entered();return {Body:body,ContentLength:bytes.length}}}})
 const reading=store.readVerified(reference,controller.signal)
 await started;await new Promise(resolve=>setImmediate(resolve));controller.abort()
 await assert.rejects(reading)
 assert.equal(requestSignal.aborted,true);assert.equal(body.destroyed,true)
})
