import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,chmod,open,symlink,link,truncate} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {preparePptxCandidate} from '../../scripts/prepare-pptx-runtime-candidate.mjs'
import {preparePptxRuntimeSubset,verifyPptxRuntimeSubset,parseNodeElfObservation} from '../../scripts/prepare-pptx-runtime-subset.mjs'

test('real Node/module subset is content bound but incomplete and nonlaunchable',async()=>{
 const sourceRoot=resolve(process.env.DYOFFICE_ARTIFACT_SOURCE_ROOT??fileURLToPath(new URL('../../../..',import.meta.url)))
 const root=await mkdtemp(join(tmpdir(),'pptx-subset-test-'))
 try{
  const module=await preparePptxCandidate({sourceRoot,outputParent:root})
  await assert.rejects(preparePptxRuntimeSubset({candidateDirectory:module.directory,expectedCandidateDigest:'0'.repeat(64),outputParent:root}))
  const made=await preparePptxRuntimeSubset({candidateDirectory:module.directory,expectedCandidateDigest:module.contentDigest,outputParent:root})
  const second=await preparePptxRuntimeSubset({candidateDirectory:module.directory,expectedCandidateDigest:module.contentDigest,outputParent:root})
  assert.equal(second.contentDigest,made.contentDigest)
  const report=await verifyPptxRuntimeSubset(made.directory,made.contentDigest)
  assert.equal(report.manifest.rootfsComplete,false)
  assert.equal(report.manifest.runtimeApproved,false)
  assert.equal(report.manifest.productionEnabled,false)
  assert.equal(report.manifest.upstreamCandidateDigest,module.contentDigest)
  assert.equal(report.manifest.node.elf.machine,'x86_64')
  assert.ok(report.manifest.node.elf.needed.length>0)
  assert.equal(report.manifest.files.find(f=>f.path==='node.elf').mode,0o644)
  assert.ok(report.manifest.files.find(f=>f.path==='node.elf').size>1000000)
  assert.ok(!JSON.stringify(report).includes(root))
  const cli=fileURLToPath(new URL('../../scripts/prepare-pptx-runtime-subset.mjs',import.meta.url))
  const checked=spawnSync(process.execPath,[cli,'verify',made.directory,made.contentDigest],{encoding:'utf8',timeout:10000,maxBuffer:8192})
  assert.equal(checked.status,0,checked.stderr)
  assert.equal(JSON.parse(checked.stdout).runtimeApproved,false)
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,'0'.repeat(64)))
  const bytes=await readFile(join(made.directory,'session.cjs'))
  await writeFile(join(made.directory,'session.cjs'),Buffer.concat([bytes,Buffer.from(' ')]))
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
  await writeFile(join(made.directory,'session.cjs'),bytes)
  await chmod(join(made.directory,'node.elf'),0o600)
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
  await chmod(join(made.directory,'node.elf'),0o644)
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v)
  const initialClosure=await readFile(join(made.directory,'closure.json'),'utf8')
  const nodePath=join(made.directory,'node.elf')
  const fd=await open(nodePath,'r+')
  try{
   const original=Buffer.alloc(1);await fd.read(original,0,1,64)
   await fd.write(Buffer.from([original[0]^1]),0,1,64)
   await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
   const newHash=createHash('sha256')
   for await(const chunk of createReadStream(nodePath))newHash.update(chunk)
   const joint=JSON.parse(initialClosure)
   joint.files.find(f=>f.path==='node.elf').sha256=newHash.digest('hex')
   await writeFile(join(made.directory,'closure.json'),canonical(joint))
   await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
   await writeFile(join(made.directory,'closure.json'),initialClosure)
   await fd.write(original,0,1,64)
  }finally{await fd.close()}
  const nodeSize=report.manifest.files.find(f=>f.path==='node.elf').size
  await truncate(nodePath,nodeSize+1)
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
  await truncate(nodePath,nodeSize)
  await writeFile(join(made.directory,'extra'),'x')
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
  await rm(join(made.directory,'extra'))
  await rm(join(made.directory,'session.cjs'))
  await symlink(join(second.directory,'session.cjs'),join(made.directory,'session.cjs'))
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
  await rm(join(made.directory,'session.cjs'))
  await link(join(second.directory,'session.cjs'),join(made.directory,'session.cjs'))
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
  await rm(join(made.directory,'session.cjs'))
  await writeFile(join(made.directory,'session.cjs'),bytes,{mode:0o644})
  const closure=await readFile(join(made.directory,'closure.json'),'utf8')
  const replaced=JSON.parse(closure);replaced.observer.toolSha256='0'.repeat(64)

  await writeFile(join(made.directory,'closure.json'),canonical(replaced))
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,made.contentDigest))
  const subsetDigest=m=>createHash('sha256').update('dyoffice-nonlaunchable-pptx-runtime-subset-v1\0').update(canonical(m)).digest('hex')
  for(const mutate of [m=>m.node.elf.type='OTHER',m=>m.node.elf.interpreter='../loader',m=>m.node.elf.needed=['libc.so.6','libc.so.6'],m=>m.node.elf.rpath=[0],m=>m.runtimeApproved=true,m=>m.extra=true]){
   const invalid=JSON.parse(closure);mutate(invalid)
   await writeFile(join(made.directory,'closure.json'),canonical(invalid))
   await assert.rejects(verifyPptxRuntimeSubset(made.directory,subsetDigest(invalid)))
  }
  const moduleManifestPath=join(made.directory,'module-manifest.json')
  const originalModuleManifest=await readFile(moduleManifestPath,'utf8')
  const invalidModule=JSON.parse(originalModuleManifest);invalidModule.profileId='xlsx-edit-v1'
  const wrongModuleText=canonical(invalidModule)
  await writeFile(moduleManifestPath,wrongModuleText)
  const invalidUpstream=JSON.parse(closure)
  invalidUpstream.upstreamCandidateDigest=createHash('sha256').update('dyoffice-nonlaunchable-pptx-candidate-v1\0').update(wrongModuleText).digest('hex')
  const wrongEntry=invalidUpstream.files.find(f=>f.path==='module-manifest.json')
  wrongEntry.size=Buffer.byteLength(wrongModuleText);wrongEntry.sha256=createHash('sha256').update(wrongModuleText).digest('hex')
  await writeFile(join(made.directory,'closure.json'),canonical(invalidUpstream))
  await assert.rejects(verifyPptxRuntimeSubset(made.directory,subsetDigest(invalidUpstream)))
  await writeFile(moduleManifestPath,originalModuleManifest)
  await writeFile(join(made.directory,'closure.json'),closure)
  await verifyPptxRuntimeSubset(made.directory,made.contentDigest)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('ELF observation rejects incomplete, non-x86 or ambiguous metadata',()=>{
 const base="Class: ELF64\nData: 2's complement, little endian\nType: EXEC (Executable file)\nMachine: Advanced Micro Devices X86-64\n[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]\n(NEEDED) Shared library: [libc.so.6]\n"
 assert.equal(parseNodeElfObservation(base).machine,'x86_64')
 for(const wrong of [base+'(NEEDED) broken entry\n',base+'(RPATH) broken entry\n',base+'(RUNPATH) broken entry\n','',base.replace('ELF64','ELF32'),base.replace('Advanced Micro Devices X86-64','AArch64'),base+base,base.replace('libc.so.6','../evil'),base.replace(/\[Requesting[^\n]+\n/,'')])assert.throws(()=>parseNodeElfObservation(wrong))
})
