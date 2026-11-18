// Trusted repository template contract ONLY. This test never enables Web PPTX creation
// or certifies a fork as OS isolation. Do not feed this harness uploaded files.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {createDocumentExecutionBoundary} from '../../worker/src/sandbox/document-execution-boundary.ts'

const template=new URL('../../../shell/build/shell-new/blank.pptx',import.meta.url)
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const textOf=slide=>JSON.stringify(slide.nodes.map(node=>node.text?.lines?.map(line=>line.runs.map(run=>run.text).join('')).join('\n')??''))

test('trusted bundled blank PPTX can be edited, exported and reopened through the existing test-only child',async()=>{
 const prior=process.env.NODE_ENV;process.env.NODE_ENV='test'
 let session,reopened
 try{
  const original=await readFile(template),originalHash=hash(original)
  session=await openIsolatedPptxSession({fileId:'trusted-new-presentation',revision:'blank-template',bytes:original},{unsafeTestOnly:true})
  const before=await session.outline(0)
  assert.equal(before.count,1)
  const added=await session.apply(0,[{op:'addElement',target:{slide:0},kind:'rect',offset:{x:914400,y:914400,cx:4572000,cy:914400},paragraphs:[{runs:[{text:'Initial title'}]}]}])
  assert.equal(added.generation,1)
  assert.equal(added.created.length,1)
  const edited=await session.apply(1,[{op:'setText',target:{slide:0,el:added.created[0].id},paragraphs:[{runs:[{text:'新建演示文稿 · saved title'}]}]}])
  assert.equal(edited.generation,2)
  await assert.rejects(session.exportBytes(1),{message:'GENERATION_CONFLICT'})
  const exported=await session.exportBytes(2)
  assert.equal(exported.generation,2)
  assert.ok(exported.bytes.length>0)
  assert.notEqual(hash(exported.bytes),originalHash)
  session.close();session=undefined
  reopened=await openIsolatedPptxSession({fileId:'trusted-new-presentation',revision:'saved-revision',bytes:exported.bytes},{unsafeTestOnly:true})
  assert.equal((await reopened.outline(0)).count,1)
  const restored=await reopened.render(0,0)
  assert.match(textOf(restored),/新建演示文稿 · saved title/)
  assert.doesNotMatch(textOf(restored),/Initial title/)
  assert.equal(hash(await readFile(template)),originalHash,'shared blank template must not be modified')
 }finally{
  session?.close();reopened?.close()
  if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior
 }
})

test('the blank template does not bypass either production or explicit fixture opt-in gates',async()=>{
 const prior=process.env.NODE_ENV
 try{
  const input={fileId:'trusted-blank',revision:'r0',bytes:await readFile(template)}
  process.env.NODE_ENV='production'
  await assert.rejects(openIsolatedPptxSession(input,{unsafeTestOnly:true}),{message:'PPTX_OS_ISOLATION_UNAVAILABLE'})
  process.env.NODE_ENV='test'
  await assert.rejects(openIsolatedPptxSession(input),{message:'PPTX_OS_ISOLATION_UNAVAILABLE'})
  // The real production factory has no enabling option, even under NODE_ENV=test.
  await assert.rejects(createDocumentExecutionBoundary().run({},input.bytes),{code:'DOCUMENT_BOUNDARY_UNAVAILABLE'})
 }finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior}
})
