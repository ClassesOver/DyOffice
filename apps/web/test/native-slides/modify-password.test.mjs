import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import JSZip from 'jszip'
import {PackageArchive} from '../../../../packages/pptx-engine/src/zip.ts'
import {verifyPptxModificationPassword} from '../../worker/src/native/pptx-modify-password.ts'

const password='Team slide review 密码'
const salt='AAECAwQFBgcICQoLDA0ODw=='

test('verifies ISO and legacy PowerPoint modification password formats',()=>{
 const iso={algorithmName:'SHA-256',saltValue:salt,spinValue:'2',hashValue:'3sT/k7vqgL/UaZ0yxqhBIt7413t4MbeSlvErPqEWTMM='}
 assert.equal(verifyPptxModificationPassword(iso,'\uFEFF'+password),'match')
 assert.equal(verifyPptxModificationPassword(iso,'Incorrect password'),'incorrect')
 // PowerPoint-generated fixture from LibreOffice's tdf144943 regression.
 // https://github.com/LibreOffice/core/commit/5697e09b3e726a38b58ce31ac0c3a97e7871c74a
 const legacy={cryptAlgorithmSid:'14',saltData:'qh98HWf4JpzDM2hMHw2pPA==',spinCount:'100000',hashData:'wMVc4kxtNHYaM+MBimsTX2w1SnwGoLuhQ0+KRY87iWS7mxZJRiRH0TG95RCucmD4d0Ih6uLaFGCO6Xd+6q4rig=='}
 assert.equal(verifyPptxModificationPassword(legacy,'password'),'match')
})

test('leaves unsupported, malformed and excessive verifiers protected',()=>{
 const iso={algorithmName:'SHA-256',saltValue:salt,spinCount:'2',hashValue:'3sT/k7vqgL/UaZ0yxqhBIt7413t4MbeSlvErPqEWTMM='}
 for(const verifier of [
  undefined,
  {...iso,hashValue:''},
  {...iso,saltValue:''},
  {...iso,spinCount:'1000001'},
  {...iso,spinValue:'3'},
  {...iso,algorithmName:'unrecognized'},
 ]){
  assert.equal(verifyPptxModificationPassword(verifier,password),'unsupported')
 }
})

test('retains read-only protection for a verifier inside a markup compatibility choice',async()=>{
 const archive=await JSZip.loadAsync(await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url)))
 const path='ppt/presentation.xml'
 const original=await archive.file(path).async('string')
 const wrapped='<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'+
  '<mc:Choice Requires="p"><p:modifyVerifier algorithmName="SHA-256" spinCount="2" saltValue="'+salt+
  '" hashValue="3sT/k7vqgL/UaZ0yxqhBIt7413t4MbeSlvErPqEWTMM="/></mc:Choice><mc:Fallback/></mc:AlternateContent>'
 archive.file(path,original.replace('</p:presentation>',wrapped+'</p:presentation>'))
 const parsed=await PackageArchive.open(await archive.generateAsync({type:'uint8array'}))
 const result=parsed.readPresentation()
 assert.equal(result.writeProtected,true)
 assert.equal(result.modifyVerifier,undefined)
})
