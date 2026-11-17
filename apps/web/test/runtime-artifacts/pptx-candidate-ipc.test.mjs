import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {spawnSync,fork} from 'node:child_process'
import {preparePptxCandidate} from '../../scripts/prepare-pptx-runtime-candidate.mjs'
import {openGeneratedPptxCandidateFixture} from '../helpers/pptx-candidate-fixture.mjs'
const PptxGenJS=createRequire(import.meta.url)('pptxgenjs')
test('actual minified candidate uses existing IPC open/outline/close on generated PPTX only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pptx-ipc-test-')),old=process.env.NODE_ENV
 let session
 try{
  const sourceRoot=resolve(process.env.DYOFFICE_ARTIFACT_SOURCE_ROOT??fileURLToPath(new URL('../../../..',import.meta.url)))
  const candidate=await preparePptxCandidate({sourceRoot,outputParent:root})
  const deck=new PptxGenJS();deck.addSlide().addText('Trusted generated fixture',{x:1,y:1,w:5,h:1})
  const bytes=Buffer.from(await deck.write({outputType:'nodebuffer'}))
  process.env.NODE_ENV='production'
  await assert.rejects(openGeneratedPptxCandidateFixture({...candidate,bytes,unsafeGeneratedFixtureOnly:true}),/FIXTURE_ONLY/)
  process.env.NODE_ENV='test'
  await assert.rejects(openGeneratedPptxCandidateFixture({...candidate,bytes}),/FIXTURE_ONLY/)
  await assert.rejects(openGeneratedPptxCandidateFixture({...candidate,bytes,contentDigest:'0'.repeat(64),unsafeGeneratedFixtureOnly:true}))
  session=await openGeneratedPptxCandidateFixture({...candidate,bytes,unsafeGeneratedFixtureOnly:true})
  assert.equal(session.opened.count,1)
  const outline=await session.outline(0)
  assert.equal(outline.count,1);assert.equal(outline.paths.length,1)
  assert.equal(await session.close(),true)
  await assert.rejects(session.outline(0),/CLOSED/)
  session=undefined
  session=await openGeneratedPptxCandidateFixture({...candidate,bytes,unsafeGeneratedFixtureOnly:true})
  await assert.rejects(session.outline(1),/GENERATION/)
  await assert.rejects(session.outline(0),/CLOSED/)
  session=undefined
  session=await openGeneratedPptxCandidateFixture({...candidate,bytes,unsafeGeneratedFixtureOnly:true})
  await assert.rejects(session.outline(0,{fileId:'wrong',revision:'wrong'}),/BINDING_CONFLICT/)
  await assert.rejects(session.outline(0),/CLOSED/)
  session=undefined
  await writeFile(join(candidate.directory,'session.cjs'),'replaced artifact')
  await assert.rejects(openGeneratedPptxCandidateFixture({...candidate,bytes,unsafeGeneratedFixtureOnly:true}))
  await rm(join(candidate.directory,'session.cjs'))
  await assert.rejects(openGeneratedPptxCandidateFixture({...candidate,bytes,unsafeGeneratedFixtureOnly:true}))
  const entry=fileURLToPath(new URL('../helpers/pptx-candidate-entry.mjs',import.meta.url))
  const denied=spawnSync(process.execPath,[entry],{env:{},timeout:3000,encoding:'utf8'})
  assert.equal(denied.status,78)
  await new Promise((resolve,reject)=>{
   const child=fork(entry,[],{execArgv:[],env:{NODE_ENV:'test'},stdio:['ignore','ignore','ignore','ipc']})
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('gate did not exit with IPC'))},3000)
   child.once('error',error=>{clearTimeout(timer);reject(error)})
   child.once('exit',code=>{clearTimeout(timer);try{assert.equal(code,78);resolve()}catch(error){reject(error)}})
  })
 }finally{
  await session?.dispose()
  if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old
  await rm(root,{recursive:true,force:true})
 }
})
