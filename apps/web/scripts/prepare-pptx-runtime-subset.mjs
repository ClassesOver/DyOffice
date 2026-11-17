// Offline, nonlaunchable subset only. No loader, library collection or execution.
import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {open,realpath,lstat,mkdtemp,writeFile,chmod,readdir,rm} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {verifyPptxCandidate,validatePptxCandidateManifest} from './prepare-pptx-runtime-candidate.mjs'
const run=promisify(execFile)
const NODE_MAX=256*1024*1024, MODULE_MAX=16*1024*1024, META_MAX=1024*1024
const DOMAIN='dyoffice-nonlaunchable-pptx-runtime-subset-v1\0'
const fail=()=>{throw new Error('RUNTIME_SUBSET_INVALID')}
const hash=b=>createHash('sha256').update(b).digest('hex')
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v)
const digest=m=>hash(Buffer.concat([Buffer.from(DOMAIN),Buffer.from(canonical(m))]))
const hex=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',')
async function safeRoot(path){const actual=await realpath(path);if(actual!==resolve(path)||(await lstat(path)).isSymbolicLink())fail();return actual}

/** Stream a bounded fixed input and optionally copy that same byte snapshot. */
async function snapshot(path,max,destination){
 const input=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 let output
 try{
  const before=await input.stat({bigint:true})
  if(!before.isFile()||before.nlink!==1n||(before.mode&0o7000n)!==0n||before.size<1n||before.size>BigInt(max))fail()
  if(destination){output=await open(destination,'wx',0o644);await output.chmod(0o644)}
  const sha=createHash('sha256'),buffer=Buffer.alloc(64*1024);let offset=0
  while(offset<Number(before.size)){
   const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,Number(before.size)-offset),offset)
   if(!bytesRead)fail()
   const chunk=buffer.subarray(0,bytesRead);sha.update(chunk)
   if(output){
    let written=0
    while(written<bytesRead){const result=await output.write(chunk,written,bytesRead-written,offset+written);if(!result.bytesWritten)fail();written+=result.bytesWritten}
   }
   offset+=bytesRead
  }
  if((await input.read(buffer,0,1,offset)).bytesRead)fail()
  const after=await input.stat({bigint:true})
  for(const field of ['dev','ino','size','mode','nlink','mtimeNs','ctimeNs'])if(before[field]!==after[field])fail()
  return {size:offset,sha256:sha.digest('hex'),mode:Number(before.mode&0o777n)}
 }finally{try{await output?.close()}finally{await input.close()}}
}
async function textFile(path,max){
 const metadata=await snapshot(path,max)
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{
  const stat=await handle.stat({bigint:true});if(!stat.isFile()||stat.nlink!==1n||(stat.mode&0o7000n)!==0n||stat.size!==BigInt(metadata.size)||Number(stat.mode&0o777n)!==metadata.mode)fail()
  const bytes=Buffer.alloc(metadata.size);let offset=0
  while(offset<bytes.length){const n=(await handle.read(bytes,offset,bytes.length-offset,offset)).bytesRead;if(!n)fail();offset+=n}
  if((await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead)fail()
  const after=await handle.stat({bigint:true})
  for(const field of ['dev','ino','size','mode','nlink','mtimeNs','ctimeNs'])if(stat[field]!==after[field])fail()
  if(hash(bytes)!==metadata.sha256)fail()
  return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),metadata}
 }finally{await handle.close()}
}
function validElf(elf){
 if(!exact(elf,['class','machine','type','interpreter','needed','rpath','runpath'])||elf.class!=='ELF64'||elf.machine!=='x86_64'||!['EXEC','DYN'].includes(elf.type)||typeof elf.interpreter!=='string'||!(/^\/[A-Za-z0-9._+/-]{1,255}$/).test(elf.interpreter)||elf.interpreter.includes('..'))fail()
 if(!Array.isArray(elf.needed)||!elf.needed.length||elf.needed.length>64||elf.needed.some((n,i)=>typeof n!=='string'||!(/^[A-Za-z0-9._+-]{1,128}$/).test(n)||(i>0&&elf.needed[i-1]>=n)))fail()
 for(const key of ['rpath','runpath'])if(!Array.isArray(elf[key])||elf[key].length>1||elf[key].some(p=>typeof p!=='string'||p.length>1024||/[\r\n\0]/.test(p)))fail()
}
export function parseNodeElfObservation(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>META_MAX)fail()
 const one=pattern=>{const matches=[...text.matchAll(pattern)];if(matches.length!==1)fail();return matches[0][1].trim()}
 if(one(/^\s*Class:\s*(.+)$/gm)!=='ELF64'||one(/^\s*Data:\s*(.+)$/gm)!=="2's complement, little endian"||one(/^\s*Machine:\s*(.+)$/gm)!=='Advanced Micro Devices X86-64')fail()
 const type=one(/^\s*Type:\s*(\S+).*$/gm);if(!['EXEC','DYN'].includes(type))fail()
 const interpreter=one(/\[Requesting program interpreter:\s*([^\]]+)\]/g)
 if(!/^\/[A-Za-z0-9._+/-]{1,255}$/.test(interpreter)||interpreter.includes('..'))fail()
 const needed=[...text.matchAll(/\(NEEDED\)\s+Shared library:\s*\[([^\]]+)\]/g)].map(m=>m[1])
 if((text.match(/\(NEEDED\)/g)??[]).length!==needed.length)fail()
 if(!needed.length||needed.length>64||new Set(needed).size!==needed.length||needed.some(n=>!(/^[A-Za-z0-9._+-]{1,128}$/).test(n)))fail()
 const paths=tag=>{const values=[...text.matchAll(new RegExp('\\('+tag+'\\)\\s+(?:Library rpath|Library runpath):\\s*\\[([^\\]]*)\\]','g'))].map(m=>m[1]);if(text.split('('+tag+')').length-1!==values.length||values.length>1||values.some(v=>v.length>1024))fail();return values}
 return {class:'ELF64',machine:'x86_64',type,interpreter,needed:needed.sort(),rpath:paths('RPATH'),runpath:paths('RUNPATH')}
}
const limits={nodeBytes:NODE_MAX,moduleBytes:MODULE_MAX,manifestBytes:META_MAX,totalBytes:NODE_MAX+MODULE_MAX+2*META_MAX}
const limitations=['missing-interpreter-and-shared-libraries','dynamic-loader-resources-not-enumerated','distribution-provenance-unverified','fonts-and-desktop-fidelity-unverified','ordinary-directory-not-immutable','not-a-production-runtime']
export async function preparePptxRuntimeSubset({candidateDirectory,expectedCandidateDigest,outputParent}){
 if(process.platform!=='linux'||process.arch!=='x64'||!/^v24\.\d+\.\d+$/.test(process.version))fail()
 candidateDirectory=await safeRoot(candidateDirectory);outputParent=await safeRoot(outputParent)
 const upstream=await verifyPptxCandidate(candidateDirectory,expectedCandidateDigest)
 const directory=await mkdtemp(join(outputParent,'pptx-runtime-subset-'))
 try{
  const module=await snapshot(join(candidateDirectory,'session.cjs'),MODULE_MAX,join(directory,'session.cjs'))
  const item=upstream.manifest.files[0]
  if(module.sha256!==item.sha256||module.size!==item.size||module.mode!==item.mode)fail()
  await snapshot(join(candidateDirectory,'manifest.json'),META_MAX,join(directory,'module-manifest.json'))
  // Revalidate the copied module pair, not just the original paths.
  const copiedManifest=await textFile(join(directory,'module-manifest.json'),META_MAX)
  if(hash(Buffer.concat([Buffer.from('dyoffice-nonlaunchable-pptx-candidate-v1\0'),Buffer.from(copiedManifest.text)]))!==expectedCandidateDigest)fail()
  const node=await snapshot(process.execPath,NODE_MAX,join(directory,'node.elf'))
  const tool=await realpath('/usr/bin/readelf')
  const toolBefore=await snapshot(tool,16*1024*1024)
  const {stdout,stderr}=await run(tool,['--wide','--file-header','--program-headers','--dynamic',join(directory,'node.elf')],{env:{LC_ALL:'C'},timeout:5000,killSignal:'SIGKILL',maxBuffer:META_MAX,encoding:'utf8'})
  if(stderr)fail()
  const elf=parseNodeElfObservation(stdout)
  const toolAfter=await snapshot(tool,16*1024*1024)
  if(canonical(toolBefore)!==canonical(toolAfter))fail()
  const nodeAfter=await snapshot(join(directory,'node.elf'),NODE_MAX)
  if(nodeAfter.sha256!==node.sha256||nodeAfter.size!==node.size)fail()
  const files=[]
  for(const [path,max] of [['module-manifest.json',META_MAX],['node.elf',NODE_MAX],['session.cjs',MODULE_MAX]]){
   files.push({path,...await snapshot(join(directory,path),max)})
  }
  const manifest={schema:1,kind:'nonlaunchable-pptx-runtime-subset',profileId:'pptx-edit-v1',policyVersion:1,architecture:'x86_64',targetDistributions:['openEuler','ubuntu'],runtimeApproved:false,rootfsComplete:false,productionEnabled:false,upstreamCandidateDigest:expectedCandidateDigest,limits,files,node:{version:process.version,elf},observer:{kind:'host-static-readelf',toolSha256:toolBefore.sha256,identityCertified:false},fontRequirement:{currentModuleDefault:'heuristic-metrics-no-font-file',desktopFidelity:'unverified-no-font-bundle'},limitations}
  const contentDigest=digest(manifest)
  await writeFile(join(directory,'closure.json'),canonical(manifest),{flag:'wx',mode:0o644});await chmod(join(directory,'closure.json'),0o644)
  await verifyPptxRuntimeSubset(directory,contentDigest)
  return {directory,contentDigest}
 }catch(error){await rm(directory,{recursive:true,force:true});throw error}
}
export async function verifyPptxRuntimeSubset(directory,expectedDigest){
 if(!hex(expectedDigest))fail()
 directory=await safeRoot(directory)
 if((await readdir(directory)).sort().join(',')!=='closure.json,module-manifest.json,node.elf,session.cjs')fail()
 const {text,metadata}=await textFile(join(directory,'closure.json'),META_MAX)
 const m=JSON.parse(text)
 if(metadata.mode!==0o644||canonical(m)!==text||digest(m)!==expectedDigest)fail()
 if(!exact(m,['schema','kind','profileId','policyVersion','architecture','targetDistributions','runtimeApproved','rootfsComplete','productionEnabled','upstreamCandidateDigest','limits','files','node','observer','fontRequirement','limitations'])||m.schema!==1||m.kind!=='nonlaunchable-pptx-runtime-subset'||m.profileId!=='pptx-edit-v1'||m.policyVersion!==1||m.architecture!=='x86_64'||m.runtimeApproved!==false||m.rootfsComplete!==false||m.productionEnabled!==false||!hex(m.upstreamCandidateDigest)||canonical(m.targetDistributions)!==canonical(['openEuler','ubuntu'])||canonical(m.limits)!==canonical(limits)||canonical(m.limitations)!==canonical(limitations))fail()
 if(!exact(m.observer,['kind','toolSha256','identityCertified'])||m.observer.kind!=='host-static-readelf'||m.observer.identityCertified!==false||!hex(m.observer.toolSha256))fail()
 if(canonical(m.fontRequirement)!==canonical({currentModuleDefault:'heuristic-metrics-no-font-file',desktopFidelity:'unverified-no-font-bundle'}))fail()
 if(!exact(m.node,['version','elf'])||typeof m.node.version!=='string'||!/^v24\.\d+\.\d+$/.test(m.node.version)||!exact(m.node.elf,['class','machine','type','interpreter','needed','rpath','runpath'])||m.node.elf.class!=='ELF64'||m.node.elf.machine!=='x86_64')fail()
 validElf(m.node.elf)
 const expected=[['module-manifest.json',META_MAX],['node.elf',NODE_MAX],['session.cjs',MODULE_MAX]]
 if(!Array.isArray(m.files)||m.files.length!==3)fail()
 for(let i=0;i<expected.length;i++){
  const [path,max]=expected[i],entry=m.files[i]
  if(!exact(entry,['path','mode','size','sha256'])||entry.path!==path||entry.mode!==0o644||!Number.isSafeInteger(entry.size)||entry.size<1||entry.size>max||!hex(entry.sha256))fail()
  const actual=await snapshot(join(directory,path),max)
  if(canonical(actual)!==canonical({mode:entry.mode,size:entry.size,sha256:entry.sha256}))fail()
 }
 if(m.files.reduce((sum,file)=>sum+file.size,metadata.size)>limits.totalBytes)fail()
 const moduleText=await textFile(join(directory,'module-manifest.json'),META_MAX)
 if(hash(Buffer.concat([Buffer.from('dyoffice-nonlaunchable-pptx-candidate-v1\0'),Buffer.from(moduleText.text)]))!==m.upstreamCandidateDigest)fail()
 const upstream=JSON.parse(moduleText.text)
 if(canonical(upstream)!==moduleText.text)fail()
 validatePptxCandidateManifest(upstream)
 const module=m.files[2]
 if(upstream.files?.length!==1||upstream.files[0].path!=='session.cjs'||upstream.files[0].sha256!==module.sha256||upstream.files[0].size!==module.size||upstream.files[0].mode!==module.mode)fail()
 return {manifest:m,contentDigest:expectedDigest}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);let result
  if(args[0]==='prepare'&&args.length===4)result=await preparePptxRuntimeSubset({candidateDirectory:args[1],expectedCandidateDigest:args[2],outputParent:args[3]})
  else if(args[0]==='verify'&&args.length===3){const verified=await verifyPptxRuntimeSubset(args[1],args[2]);result={contentDigest:verified.contentDigest}}
  else throw new Error('Usage: prepare-pptx-runtime-subset.mjs prepare CANDIDATE EXPECTED_DIGEST OUTPUT_PARENT | verify DIRECTORY EXPECTED_DIGEST')
  process.stdout.write(JSON.stringify({kind:'nonlaunchable-pptx-runtime-subset',runtimeApproved:false,rootfsComplete:false,productionEnabled:false,...result})+'\n')
 }catch(error){process.stderr.write((error instanceof Error?error.message:'RUNTIME_SUBSET_INVALID')+'\n');process.exitCode=1}
}
