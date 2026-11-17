// Offline build tooling only. Never registers a runtime or executes the bundle.
import {build,version as esbuildVersion} from 'esbuild'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {constants} from 'node:fs'
import {open,realpath,lstat,readdir,mkdtemp,writeFile,chmod,rm} from 'node:fs/promises'
import {resolve,relative,dirname,join,extname,isAbsolute} from 'node:path'
import {builtinModules,createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const initialCompilerOverride=process.env.ESBUILD_BINARY_PATH

const PINNED_ESBUILD='0.25.12'
const ENTRY='apps/web/worker/src/native/pptx-session.ts'
const MAX_FILE=16*1024*1024, MAX_TOTAL=64*1024*1024, MAX_INPUTS=1024
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',')
const hex=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const fixedRecipe=()=>({entry:ENTRY,platform:'node',format:'cjs',target:'node24',minify:true,legalComments:'eof',markdownLoader:'text',tsconfig:{target:'ES2022',useDefineForClassFields:true},esbuildVersion:PINNED_ESBUILD})
function fail(){throw new Error('RUNTIME_CANDIDATE_INVALID')}
function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'
 return JSON.stringify(value)
}
function digest(manifest){return sha(Buffer.concat([Buffer.from('dyoffice-nonlaunchable-pptx-candidate-v1\0'),Buffer.from(canonical(manifest))]))}
const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith('..'+ '/')&&!isAbsolute(rel)}
async function bytesOf(path,max=MAX_FILE,allowHardlinks=false){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{
  const stat=await handle.stat()
  if(!stat.isFile()||(stat.mode&0o7000)!==0||(!allowHardlinks&&stat.nlink!==1)||stat.size<0||stat.size>max)fail()
  const bytes=Buffer.alloc(stat.size)
  let offset=0
  while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)fail();offset+=bytesRead}
  const tail=Buffer.alloc(1)
  if((await handle.read(tail,0,1,offset)).bytesRead)fail()
  const after=await handle.stat()
  if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)fail()
  return {bytes,mode:stat.mode&0o777}
 }finally{await handle.close()}
}
async function packageInfo(file){
 let directory=dirname(file)
 for(let i=0;i<32;i++){
  try{
   const {bytes}=await bytesOf(join(directory,'package.json'),1024*1024)
   const value=JSON.parse(bytes)
   if(typeof value.name==='string'&&typeof value.version==='string'&&/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value.name)&&/^[a-z0-9.+_-]+$/i.test(value.version)){
    return {directory,name:value.name,version:value.version,manifestSha256:sha(bytes)}
   }
  }catch(error){if(error.code!=='ENOENT')throw error}
  const parent=dirname(directory);if(parent===directory)break;directory=parent
 }
 fail()
}
async function safeRoot(path){
 const actual=await realpath(path)
 if(actual!==resolve(path)||(await lstat(path)).isSymbolicLink())fail()
 return actual
}

/** sourceRoot/outputParent are trusted offline operator configuration, not requests. */
export async function preparePptxCandidate({sourceRoot,outputParent}){
 if(esbuildVersion!==PINNED_ESBUILD)fail()
 if(initialCompilerOverride!==undefined||process.env.ESBUILD_BINARY_PATH!==undefined||process.platform!=='linux'||process.arch!=='x64')fail()
 const wrapper=await bytesOf(require.resolve('esbuild'),MAX_FILE,true)
 const compilerRequire=createRequire(require.resolve('esbuild'))
 const compiler=await bytesOf(compilerRequire.resolve('@esbuild/linux-x64/bin/esbuild'),MAX_FILE,true)
 sourceRoot=await safeRoot(sourceRoot)
 outputParent=await safeRoot(outputParent)
 const inputs=new Map();let total=0
 const result=await build({
  absWorkingDir:sourceRoot,entryPoints:[ENTRY],outfile:'session.cjs',
  bundle:true,platform:'node',format:'cjs',target:'node24',
  tsconfigRaw:{compilerOptions:{target:'ES2022',useDefineForClassFields:true}},minify:true,legalComments:'eof',sourcemap:false,write:false,metafile:true,logLevel:'silent',
  plugins:[{name:'snapshot-inputs',setup(api){api.onLoad({filter:/.*/},async args=>{
   if(args.namespace!=='file')fail()
   const actual=await realpath(args.path), workspace=inside(sourceRoot,actual)&&!actual.includes('/node_modules/')
   const info=await packageInfo(actual)
   if(!workspace&&!actual.includes('/node_modules/'))fail()
   const local=relative(workspace?sourceRoot:info.directory,actual).split('\\').join('/')
   if(local.startsWith('../')||isAbsolute(local))fail()
   const id=workspace?'workspace:'+local:'dependency:'+info.name+'@'+info.version+'/'+local
   const {bytes,mode}=await bytesOf(actual)
   total+=bytes.length;if(total>MAX_TOTAL||inputs.size>=MAX_INPUTS)fail()
   const record={id,mode,size:bytes.length,sha256:sha(bytes),package:info.name,packageVersion:info.version,packageManifestSha256:info.manifestSha256}
   if(inputs.has(id)&&canonical(inputs.get(id))!==canonical(record))fail()
   inputs.set(id,record)
   const loader={'.ts':'ts','.tsx':'tsx','.js':'js','.mjs':'js','.cjs':'js','.json':'json','.md':'text'}[extname(actual)]
   if(!loader)fail()
   return {contents:bytes,loader,resolveDir:dirname(actual)}
  })}}]
 })
 if(result.outputFiles.length!==1)fail()
 const artifact=Buffer.from(result.outputFiles[0].contents)
 if(!artifact.length||artifact.length>MAX_FILE||artifact.includes(Buffer.from(sourceRoot))||artifact.includes(Buffer.from('sourceMappingURL')))fail()
 const externals=[...new Set(Object.values(result.metafile.outputs).flatMap(o=>o.imports.filter(i=>i.external).map(i=>i.path)))].sort()
 const allowed=new Set(builtinModules.flatMap(x=>[x,'node:'+x]))
 if(externals.some(x=>!allowed.has(x)))fail()
 const manifest={
  schema:1,kind:'nonlaunchable-pptx-module-candidate',profileId:'pptx-edit-v1',policyVersion:1,
  architecture:'x86_64',targetDistributions:['openEuler','ubuntu'],productionEnabled:false,runtimeApproved:false,rootfsComplete:false,
  sourceAuthentication:'unverified-build-snapshots',dependencyAuthentication:'unverified',
  toolchain:{esbuildVersion,wrapperSha256:sha(wrapper.bytes),nativeBinarySha256:sha(compiler.bytes),nativeBinaryMode:compiler.mode,nodeVersion:process.version,identityCertified:false},
  recipe:fixedRecipe(),
  inputs:[...inputs.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),externals,
  files:[{path:'session.cjs',mode:0o644,size:artifact.length,sha256:sha(artifact)}]
 }
 const contentDigest=digest(manifest)
 const directory=await mkdtemp(join(outputParent,'pptx-candidate-'))
 try{
  await writeFile(join(directory,'session.cjs'),artifact,{flag:'wx',mode:0o644})
  await chmod(join(directory,'session.cjs'),0o644)
  await writeFile(join(directory,'manifest.json'),canonical(manifest),{flag:'wx',mode:0o644})
  await chmod(join(directory,'manifest.json'),0o644)
  await verifyPptxCandidate(directory,contentDigest)
  return {directory,contentDigest}
 }catch(error){await rm(directory,{recursive:true,force:true});throw error}
}

/** Structural validation only: not bytes, provenance or authorization. */
export function validatePptxCandidateManifest(manifest){
 if(!exact(manifest,['schema','kind','profileId','policyVersion','architecture','targetDistributions','productionEnabled','runtimeApproved','rootfsComplete','sourceAuthentication','dependencyAuthentication','toolchain','recipe','inputs','externals','files']))fail()
 if(canonical(manifest.recipe)!==canonical(fixedRecipe())||canonical(manifest.targetDistributions)!==canonical(['openEuler','ubuntu'])||manifest.sourceAuthentication!=='unverified-build-snapshots'||manifest.dependencyAuthentication!=='unverified')fail()
 const tool=manifest.toolchain
 if(!exact(tool,['esbuildVersion','wrapperSha256','nativeBinarySha256','nativeBinaryMode','nodeVersion','identityCertified'])||tool.esbuildVersion!==PINNED_ESBUILD||tool.identityCertified!==false||!hex(tool.wrapperSha256)||!hex(tool.nativeBinarySha256)||!Number.isInteger(tool.nativeBinaryMode)||tool.nativeBinaryMode<0||tool.nativeBinaryMode>0o777||typeof tool.nodeVersion!=='string'||!/^v24\.\d+\.\d+$/.test(tool.nodeVersion))fail()
 if(!Array.isArray(manifest.inputs)||!manifest.inputs.length||manifest.inputs.length>MAX_INPUTS)fail()
 let previous='',total=0
 for(const input of manifest.inputs){
  if(!exact(input,['id','mode','size','sha256','package','packageVersion','packageManifestSha256'])||typeof input.id!=='string'||input.id.length>1024||!(/^(workspace:|dependency:)[a-zA-Z0-9@._+/:?-]+$/).test(input.id)||input.id.includes('..')||input.id<=previous||!Number.isSafeInteger(input.size)||input.size<0||input.size>MAX_FILE||!Number.isInteger(input.mode)||input.mode<0||input.mode>0o777||!hex(input.sha256)||!hex(input.packageManifestSha256)||typeof input.package!=='string'||!(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i).test(input.package)||typeof input.packageVersion!=='string'||!(/^[a-z0-9.+_-]+$/i).test(input.packageVersion))fail()
  previous=input.id;total+=input.size
 }
 if(total>MAX_TOTAL)fail()
 const allowed=new Set(builtinModules.flatMap(x=>[x,'node:'+x]))
 if(!Array.isArray(manifest.externals)||manifest.externals.length>128||manifest.externals.some((x,i)=>typeof x!=='string'||!allowed.has(x)||(i>0&&manifest.externals[i-1]>=x)))fail()
 if(manifest.schema!==1||manifest.kind!=='nonlaunchable-pptx-module-candidate'||manifest.profileId!=='pptx-edit-v1'||manifest.policyVersion!==1||manifest.architecture!=='x86_64'||manifest.productionEnabled!==false||manifest.runtimeApproved!==false||manifest.rootfsComplete!==false)fail()
 if(!Array.isArray(manifest.files)||manifest.files.length!==1)fail()
 const item=manifest.files[0]
 if(!exact(item,['path','mode','size','sha256']))fail()
 if(item.path!=='session.cjs'||item.mode!==0o644||!Number.isSafeInteger(item.size)||item.size<1||item.size>MAX_FILE||!/^[0-9a-f]{64}$/.test(item.sha256))fail()
}

/** Expected identity must be held outside the replaceable artifact directory. */
export async function verifyPptxCandidate(directory,expectedContentDigest){
 if(typeof expectedContentDigest!=='string'||!/^[0-9a-f]{64}$/.test(expectedContentDigest))fail()
 directory=await safeRoot(directory)
 if((await readdir(directory)).sort().join(',')!=='manifest.json,session.cjs')fail()
 const stored=await bytesOf(join(directory,'manifest.json'),1024*1024)
 if(stored.mode!==0o644)fail()
 const text=new TextDecoder('utf-8',{fatal:true}).decode(stored.bytes)
 const manifest=JSON.parse(text)
 if(canonical(manifest)!==text||digest(manifest)!==expectedContentDigest)fail()
 validatePptxCandidateManifest(manifest)
 const item=manifest.files[0]
 const actual=await bytesOf(join(directory,'session.cjs'))
 if(actual.mode!==item.mode||actual.bytes.length!==item.size||sha(actual.bytes)!==item.sha256)fail()
 // Returned identity describes these read snapshots, never a future exec-by-path.
 return {manifest,contentDigest:expectedContentDigest}
}

// Explicit offline CLI. No entry/command/environment override flags.
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2)
 try{
  let result
  if(args[0]==='prepare'&&args.length===2){
   result=await preparePptxCandidate({sourceRoot:fileURLToPath(new URL('../../..',import.meta.url)),outputParent:args[1]})
  }else if(args[0]==='verify'&&args.length===3){
   const verified=await verifyPptxCandidate(args[1],args[2])
   result={contentDigest:verified.contentDigest}
  }else{
   throw new Error('Usage: prepare-pptx-runtime-candidate.mjs prepare OUTPUT_PARENT | verify DIRECTORY EXPECTED_DIGEST')
  }
  process.stdout.write(JSON.stringify({kind:'nonlaunchable-pptx-module-candidate',runtimeApproved:false,rootfsComplete:false,productionEnabled:false,...result})+'\n')
 }catch(error){
  process.stderr.write((error instanceof Error?error.message:'RUNTIME_CANDIDATE_INVALID')+'\n')
  process.exitCode=1
 }
}
