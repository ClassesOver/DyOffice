import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {spawn} from 'node:child_process'


const bytes=()=>readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))

test('isolated session parses untrusted bytes in a child process and stays generation-fenced',async t=>{
 const raw=await bytes()
 const session=await openIsolatedPptxSession({fileId:'f-isolated',revision:'r-1',bytes:raw},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 assert.deepEqual(session.binding,{fileId:'f-isolated',revision:'r-1'})
 const outline=await session.outline(0)
 assert.equal(outline.count,2)
 assert.deepEqual(outline.paths,['ppt/slides/slide1.xml','ppt/slides/slide2.xml'])
 assert.ok(outline.defaultFont && outline.defaultFont.length>0)
 const applied=await session.apply(0,[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'child edited'}]}]}])
 assert.equal(applied.generation,1)
 assert.equal(applied.stateGeneration,1)
 assert.deepEqual(applied.slideIds,['s_1','s_2'])
 assert.ok(applied.records[0].slideId==='s_1')
 const render=await session.render(1,0,1280)
 assert.equal(render.widthPx,1280)
 assert.equal(render.partPath,'ppt/slides/slide1.xml')
 const exported=await session.exportBytes(1)
 assert.equal(exported.generation,1)
 assert.deepEqual([...exported.bytes.slice(0,2)],[0x50,0x4b],'export starts with the ZIP magic')
 await assert.rejects(()=>session.apply(0,[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'stale'}]}]}]),{message:'GENERATION_CONFLICT'})
 const undone=await session.undo(1)
 assert.equal(undone.generation,2)
 assert.equal(undone.stateGeneration,0)
 assert.equal(undone.slides.length,2)
 const redone=await session.redo(2)
 assert.equal(redone.generation,3)
 assert.equal(redone.stateGeneration,1)
 assert.equal(redone.slides.length,2)
})

test('oversized input never reaches a child process',async()=>{
 await assert.rejects(()=>openIsolatedPptxSession({fileId:'f',revision:'r',bytes:new Uint8Array(32*1024*1024+1)},{unsafeTestOnly:true}),{message:'INPUT_LIMIT'})
})

test('close() terminates the child process and settles later calls',async()=>{
 const raw=await bytes()
 const session=await openIsolatedPptxSession({fileId:'f-close',revision:'r',bytes:raw},{timeoutMs:60000,unsafeTestOnly:true})
 session.close()
 await assert.rejects(()=>session.outline(0),{message:'SESSION_CLOSED'})
 await assert.rejects(()=>session.apply(0,[{op:'addBlankSlide',target:{slide:0}}]),{message:'SESSION_CLOSED'})
})

test('a killed child fails pending and later calls with SESSION_CLOSED',async()=>{
 const raw=await bytes()
 const session=await openIsolatedPptxSession({fileId:'f-kill',revision:'r',bytes:raw},{timeoutMs:60000,unsafeTestOnly:true})
 await session.outline(0)
 // Kill the underlying child directly: the proxy learns about it through exit.
 const found=await new Promise(resolve=>{
   const probe=spawn('bash',['-c',`ps -o pid=,args= --ppid ${process.pid} | grep "pptx-session-child.ts" | grep -v grep | awk '{print $1}'`],{stdio:['ignore','pipe','pipe']})
   let out=''
   probe.stdout.on('data',chunk=>{out+=chunk})
   probe.on('close',()=>resolve(out.trim().split('\n').filter(Boolean).map(Number)))
 })
 assert.ok(found.length>=1,'a session child process must exist')
 for (const pid of found) process.kill(pid,'SIGKILL')
 await new Promise(resolve=>setTimeout(resolve,150))
 await assert.rejects(()=>session.outline(0),{message:'SESSION_CLOSED'})
 await assert.rejects(()=>session.exportBytes(0),{message:'SESSION_CLOSED'})
})
