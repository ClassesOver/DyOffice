import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,symlink,link,chmod,mkdir,truncate,copyFile,readdir,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {preparePptxCandidate,verifyPptxCandidate} from '../../scripts/prepare-pptx-runtime-candidate.mjs'

test('actual fixed PPTX build has repeatable content identity and rejects tampering',async()=>{
 const sourceRoot=resolve(process.env.DYOFFICE_ARTIFACT_SOURCE_ROOT??fileURLToPath(new URL('../../../..',import.meta.url)))
 const root=await mkdtemp(join(tmpdir(),'pptx-candidate-test-'))
 try{
  const prior=process.env.ESBUILD_BINARY_PATH
  try{
   process.env.ESBUILD_BINARY_PATH='/not-allowed'
   await assert.rejects(preparePptxCandidate({sourceRoot,outputParent:root}))
  }finally{if(prior===undefined)delete process.env.ESBUILD_BINARY_PATH;else process.env.ESBUILD_BINARY_PATH=prior}
  const a=await preparePptxCandidate({sourceRoot,outputParent:root})
  const b=await preparePptxCandidate({sourceRoot,outputParent:root})
  assert.equal(a.contentDigest,b.contentDigest)
  const cli=fileURLToPath(new URL('../../scripts/prepare-pptx-runtime-candidate.mjs',import.meta.url))
  const result=spawnSync(process.execPath,[cli,'verify',a.directory,a.contentDigest],{encoding:'utf8',timeout:5000,maxBuffer:4096})
  assert.equal(result.status,0,result.stderr)
  assert.equal(JSON.parse(result.stdout).runtimeApproved,false)
  assert.equal(JSON.parse(result.stdout).contentDigest,a.contentDigest)
  assert.notEqual(spawnSync(process.execPath,[cli,'verify',a.directory,a.contentDigest,'--entry','evil'],{encoding:'utf8',timeout:5000}).status,0)
  const good=await verifyPptxCandidate(a.directory,a.contentDigest)
  // Native optional package is reachable only from esbuild's own installation,
  // not this isolated script's node_modules. Exercise actual CLI prepare.
  const isolated=join(root,'nonhoisted');await mkdir(isolated)
  const workspacePaths=good.manifest.inputs.filter(i=>i.id.startsWith('workspace:')).map(i=>i.id.slice(10))
  const manifests=new Set(['apps/web/package.json',...workspacePaths.filter(p=>p.startsWith('packages/')).map(p=>p.split('/').slice(0,2).join('/')+'/package.json')])
  for(const path of [...workspacePaths,...manifests]){
   await mkdir(dirname(join(isolated,path)),{recursive:true})
   await copyFile(join(sourceRoot,path),join(isolated,path))
  }
  const modules=join(isolated,'node_modules');await mkdir(join(modules,'@genoffice'),{recursive:true})
  for(const name of await readdir(join(sourceRoot,'node_modules'))){
   if(name.startsWith('@')||name.startsWith('.'))continue
   await symlink(await realpath(join(sourceRoot,'node_modules',name)),join(modules,name))
  }
  for(const path of manifests){
   if(!path.startsWith('packages/'))continue
   const name=path.split('/')[1]
   await symlink(join(isolated,'packages',name),join(modules,'@genoffice',name))
  }
  const isolatedScript=join(isolated,'apps/web/scripts/prepare-pptx-runtime-candidate.mjs')
  await mkdir(dirname(isolatedScript),{recursive:true});await copyFile(cli,isolatedScript)
  const prepared=spawnSync(process.execPath,[isolatedScript,'prepare',root],{encoding:'utf8',timeout:10000,maxBuffer:8192})
  assert.equal(prepared.status,0,prepared.stderr)
  const cliCandidate=JSON.parse(prepared.stdout)
  assert.equal(cliCandidate.runtimeApproved,false)
  assert.equal(cliCandidate.contentDigest,a.contentDigest)
  await verifyPptxCandidate(cliCandidate.directory,cliCandidate.contentDigest)
  assert.equal(good.manifest.profileId,'pptx-edit-v1')
  assert.equal(good.manifest.rootfsComplete,false)
  assert.equal(good.manifest.runtimeApproved,false)
  assert.ok(good.manifest.inputs.length>100)
  const text=await readFile(join(a.directory,'manifest.json'),'utf8')
  assert.ok(!text.includes(sourceRoot))
  const bundle=await readFile(join(a.directory,'session.cjs'))
  assert.ok(bundle.length>100000)
  assert.ok(!bundle.toString().includes(sourceRoot))
  assert.ok(!bundle.toString().includes('sourceMappingURL'))
  await writeFile(join(a.directory,'session.cjs'),Buffer.concat([bundle,Buffer.from(' ')]))
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  // Self-consistent replacement cannot override independently pinned identity.
  const replaced=JSON.parse(text), changed=Buffer.concat([bundle,Buffer.from(' ')])
  replaced.files[0].sha256=createHash('sha256').update(changed).digest('hex')
  replaced.files[0].size=changed.length
  const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value)
  await writeFile(join(a.directory,'manifest.json'),canonical(replaced))
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await writeFile(join(a.directory,'manifest.json'),text)
  await writeFile(join(a.directory,'session.cjs'),bundle)
  await chmod(join(a.directory,'session.cjs'),0o600)
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await chmod(join(a.directory,'session.cjs'),0o644)
  await writeFile(join(a.directory,'extra'),'x')
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await rm(join(a.directory,'extra'))
  await rm(join(a.directory,'session.cjs'))
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await mkdir(join(a.directory,'session.cjs'))
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await rm(join(a.directory,'session.cjs'),{recursive:true})
  await symlink(join(b.directory,'session.cjs'),join(a.directory,'session.cjs'))
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await rm(join(a.directory,'session.cjs'))
  await link(join(b.directory,'session.cjs'),join(a.directory,'session.cjs'))
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await rm(join(a.directory,'session.cjs'))
  await writeFile(join(a.directory,'session.cjs'),bundle,{mode:0o644})
  await truncate(join(a.directory,'session.cjs'),16*1024*1024+1)
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await writeFile(join(a.directory,'session.cjs'),bundle)
  await writeFile(join(a.directory,'manifest.json'),text.replace('pptx-edit-v1','xlsx-edit-v1'))
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await writeFile(join(a.directory,'manifest.json'),'{"schema":1,'+text.slice(1))
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await writeFile(join(a.directory,'manifest.json'),text+' ')
  await assert.rejects(verifyPptxCandidate(a.directory,a.contentDigest))
  await writeFile(join(a.directory,'manifest.json'),text)
  for(const mutate of [
   m=>m.recipe.entry='other.ts',
   m=>m.recipe.target='node26',
   m=>m.recipe.format='esm',
   m=>m.targetDistributions=['other'],
   m=>m.toolchain.identityCertified=true,
   m=>m.toolchain.esbuildVersion='0.0.0',
   m=>m.sourceAuthentication='certified',
   m=>m.extra=true,
   m=>m.inputs.push(m.inputs[0]),
   m=>m.externals=['untrusted-package'],
  ]){
   const changedManifest=JSON.parse(text);mutate(changedManifest)
   const encoded=canonical(changedManifest)
   const selfDigest=createHash('sha256').update('dyoffice-nonlaunchable-pptx-candidate-v1\0').update(encoded).digest('hex')
   await writeFile(join(a.directory,'manifest.json'),encoded)
   await assert.rejects(verifyPptxCandidate(a.directory,selfDigest))
  }
  await writeFile(join(a.directory,'manifest.json'),text)
  await assert.rejects(verifyPptxCandidate(a.directory,'0'.repeat(64)))
  await verifyPptxCandidate(a.directory,a.contentDigest)
 }finally{await rm(root,{recursive:true,force:true})}
})
