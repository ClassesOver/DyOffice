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
import {hashProtectionPassword} from '../../../../packages/docx-engine/src/protection.ts'
import JSZip from 'jszip'
const PptxGenJS=createRequire(import.meta.url)('pptxgenjs')
test('actual minified candidate edits, exports and reopens a generated PPTX over existing IPC',async()=>{
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
  const marker='Office 助手讲者备注'
  const createPage=[
   {op:'addBlankSlide',target:{slide:0}},
  ]
  const note={op:'setNotes',target:{slide:1},text:marker}
  const premature=await session.apply(0,[...createPage,note])
  assert.equal(premature.transaction.applied,false)
  assert.match(premature.transaction.failures[0].error,/slide index 1 is out of range/)
  assert.equal(premature.count,1)
  const applied=await session.apply(0,createPage)
  assert.equal(applied.transaction.applied,true,JSON.stringify(applied.transaction.failures))
  assert.equal(applied.generation,1)
  assert.equal(applied.count,2)
  assert.equal((await session.outline(1)).count,2)
  const noted=await session.apply(1,[note])
  assert.equal(noted.transaction.applied,true,JSON.stringify(noted.transaction.failures))
  assert.equal(noted.generation,2)
  const exported=await session.exportBytes(2)
  const original=await JSZip.loadAsync(bytes),result=await JSZip.loadAsync(exported.bytes)
  assert.match(await result.file('ppt/slides/slide1.xml').async('string'),/Trusted generated fixture/)
  assert.ok(!(await Promise.all(original.file(/^ppt\/notesSlides\/notesSlide\d+\.xml$/).map(item=>item.async('string')))).some(xml=>xml.includes(marker)))
  assert.ok((await Promise.all(result.file(/^ppt\/notesSlides\/notesSlide\d+\.xml$/).map(item=>item.async('string')))).some(xml=>xml.includes(marker)))
  assert.equal(await session.close(),true)
  await assert.rejects(session.outline(2),/CLOSED/)
  session=await openGeneratedPptxCandidateFixture({...candidate,bytes:exported.bytes,unsafeGeneratedFixtureOnly:true})
  assert.equal((await session.outline(0)).count,2)
  assert.equal(await session.close(),true)
  session=undefined
  session=await openGeneratedPptxCandidateFixture({...candidate,bytes,unsafeGeneratedFixtureOnly:true})
  await assert.rejects(session.outline(1),/GENERATION/)
  await assert.rejects(session.outline(0),/CLOSED/)
  session=undefined
  session=await openGeneratedPptxCandidateFixture({...candidate,bytes,unsafeGeneratedFixtureOnly:true})
  await assert.rejects(session.outline(0,{fileId:'wrong',revision:'wrong'}),/BINDING_CONFLICT/)
  await assert.rejects(session.outline(0),/CLOSED/)
  session=undefined
  const lockedPackage=await JSZip.loadAsync(bytes)
  const presentationPath='ppt/presentation.xml'
  const presentation=await lockedPackage.file(presentationPath).async('string')
  assert.match(presentation,/<\/p:presentation>/)
  const {hash,salt,spinCount}=await hashProtectionPassword('Synthetic PPTX modify password',1000)
  lockedPackage.file(presentationPath,presentation.replace('</p:presentation>',
   `<p:modifyVerifier algorithmName="SHA-512" hashValue="${hash}" saltValue="${salt}" spinCount="${spinCount}"/></p:presentation>`))
  const lockedBytes=await lockedPackage.generateAsync({type:'nodebuffer'})
  session=await openGeneratedPptxCandidateFixture({...candidate,bytes:lockedBytes,unsafeGeneratedFixtureOnly:true})
  assert.equal((await session.outline(0)).writeProtected,true)
  await assert.rejects(session.apply(0,[{op:'setNotes',target:{slide:0},text:marker}]),/PPTX_WRITE_PROTECTED/)
  await session.dispose()
  session=await openGeneratedPptxCandidateFixture({...candidate,bytes:lockedBytes,unsafeGeneratedFixtureOnly:true})
  await assert.rejects(session.exportBytes(0),/PPTX_WRITE_PROTECTED/)
  await session.dispose()
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
