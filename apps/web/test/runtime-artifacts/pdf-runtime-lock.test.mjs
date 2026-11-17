import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {preparePdfCandidate,verifyPdfCandidate,validatePdfCandidateManifest} from '../../scripts/prepare-pdf-runtime-candidate.mjs'
const lock=JSON.parse(await readFile(new URL('../../../../tools/dyoffice/runtime-lock.json',import.meta.url),'utf8'))
test('PDF candidate targets the locked CI Node and retains strict non-authorizing identity',async t=>{
 assert.ok(process.version==='v'+lock.node.version||/^v24\.\d+\.\d+$/.test(process.version),'run with locked CI Node22 or existing local Node24')
 const outputParent=await mkdtemp(join(tmpdir(),'pdf-node-lock-'));t.after(()=>rm(outputParent,{recursive:true,force:true}))
 const candidate=await preparePdfCandidate({sourceRoot:fileURLToPath(new URL('../../../..',import.meta.url)),outputParent})
 const {manifest}=await verifyPdfCandidate(candidate.directory,candidate.contentDigest)
 assert.equal(manifest.toolchain.nodeVersion,process.version)
 assert.equal(manifest.recipe.target,'node22')
 assert.equal(manifest.toolchain.identityCertified,false)
 assert.equal(manifest.runtimeApproved,false);assert.equal(manifest.productionEnabled,false)
 for(const version of ['v'+lock.node.version,'v24.0.0','v24.22.1']){
  const changed=structuredClone(manifest);changed.toolchain.nodeVersion=version
  assert.doesNotThrow(()=>validatePdfCandidateManifest(changed))
 }
 for(const version of ['v20.0.0','v22.0.0','v22.23.6','v23.0.0','v24.22.1-rc.1','v25.0.0']){
  const changed=structuredClone(manifest);changed.toolchain.nodeVersion=version
  assert.throws(()=>validatePdfCandidateManifest(changed),/RUNTIME_CANDIDATE_INVALID/)
 }
 for(const target of ['node20','node24']){
  const changed=structuredClone(manifest);changed.recipe.target=target
  assert.throws(()=>validatePdfCandidateManifest(changed),/RUNTIME_CANDIDATE_INVALID/)
 }
})
