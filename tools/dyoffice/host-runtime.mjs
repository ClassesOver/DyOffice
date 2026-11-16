export const lock={node:{version:'22.23.5',sha256:'2f822d544601dfff107f57d945b649d15c5bf6302595735a6bd9cdc7ee9669bd'},packages:{'postgresql-17':'17.12-1.pgdg24.04+1','postgresql-client-17':'17.12-1.pgdg24.04+1','redis-server':'5:7.0.15-1ubuntu0.24.04.5','redis-tools':'5:7.0.15-1ubuntu0.24.04.5'}}
export function validateNode(value){
 if(value?.version!==lock.node.version||value?.sha256!==lock.node.sha256)throw new Error("Host runtime mismatch: Node")
}
export function validateHost(value,{native=false,objectstore=false}={}){
 const fail=label=>{throw new Error('Host runtime mismatch: '+label)}
 if(value.platform!=='linux'||value.arch!=='x64'||value.os?.ID!=='ubuntu'||value.os?.VERSION_ID!=='24.04')fail('platform')
 validateNode(value.node)
 for(const [name,version] of Object.entries(lock.packages))if(value.packages?.[name]!==version)fail(name)
 if(native&&(!/^rustc 1\.93\.0 /.test(value.rust?.rustc||'')||!/^cargo 1\.93\.0 /.test(value.rust?.cargo||'')))fail('Rust toolchain')
 if(objectstore&&(value.objectstore?.archiveSha256!=='4f0bf3fecbe861467427ff506aee22c302cfd5ac8b7dcbde71714f8e5e680dea'||value.objectstore?.ready!==true))fail('RustFS artifact/readiness')
 if(value.postgresVersion!=='170012')fail('PostgreSQL service')
 if(value.redisVersion!=='7.0.15')fail('Redis service')
 if(!/^\d+$/.test(value.systemdVersion)||Number(value.systemdVersion)<255||value.cgroup!=='cgroup2fs')fail('systemd/cgroup ABI')
}

// This is a CI admission/observation manifest, not a reproducible OS or release image.
import {createHash} from 'node:crypto'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {execFile,spawn} from 'node:child_process'
import {createReadStream} from 'node:fs'
import {promisify} from 'node:util'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const exec=promisify(execFile)
const run=async(cmd,args,options={})=>(await exec(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,...options})).stdout.trim()
const hash=async path=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex')}
export async function collectHost({native=false,objectstore=false}={}){
 if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Disposable GitHub CI only')
 const os=Object.fromEntries((await readFile('/etc/os-release','utf8')).split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).replace(/^"|"$/g,'')]}))
 const packages={};for(const name of Object.keys(lock.packages))packages[name]=await run('dpkg-query',['-W','-f=${Version}',name])
 const result={schema:1,scope:'CI host runtime admission; not an immutable OS or production release',gitCommit:process.env.GITHUB_SHA,runner:{imageOS:process.env.ImageOS,imageVersion:process.env.ImageVersion},platform:process.platform,arch:process.arch,os,node:{version:process.versions.node,sha256:await hash(process.execPath)},packages,
  postgresVersion:await run('psql',['-h','127.0.0.1','-p','55432','-U','postgres','-d','dyoffice_test','-Atc','SHOW server_version_num'],{env:{...process.env,PGPASSWORD:'dyoffice-ci-test-only'}}),
  redisVersion:(await run('redis-cli',['-h','127.0.0.1','-p','16379','INFO','server'])).match(/^redis_version:(.+)\r?$/m)?.[1]?.trim(),
  systemdVersion:(await run('systemctl',['--version'])).match(/^systemd (\d+)/)?.[1],cgroup:await run('stat',['-fc','%T','/sys/fs/cgroup']),
  observed:{kernel:await run('uname',['-r']),glibc:await run('getconf',['GNU_LIBC_VERSION']),cc:await run('cc',['--version']),postgresSha256:await hash('/usr/lib/postgresql/17/bin/postgres'),redisSha256:await hash('/usr/bin/redis-server')}}
 if(native)result.rust={rustc:await run('rustc',['--version','--verbose']),cargo:await run('cargo',['--version'])}
 if(objectstore){
  const archiveSha256=await hash('/tmp/dyoffice-rustfs.zip')
  if(archiveSha256!=='4f0bf3fecbe861467427ff506aee22c302cfd5ac8b7dcbde71714f8e5e680dea')throw new Error('RustFS archive mismatch')
  const binarySha256=await hashCommand('unzip',['-p','/tmp/dyoffice-rustfs.zip','rustfs'])
  if(binarySha256!==await hash('/usr/local/bin/dyoffice-test-rustfs'))throw new Error('Installed RustFS differs from pinned archive')
  const response=await fetch('http://127.0.0.1:19000/health/ready',{redirect:'error',signal:AbortSignal.timeout(5000)})
  result.objectstore={version:'1.0.6',archiveSha256,binarySha256,ready:response.ok};await response.body?.cancel()
 }
 validateHost(result,{native,objectstore});return result
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);if(args.length===1&&args[0]==='--node-only'){validateNode({version:process.versions.node,sha256:await hash(process.execPath)});console.log('Verified immutable host Node executable');process.exit(0)}
  if(args.some(a=>!['--native','--objectstore'].includes(a)))throw new Error('Unknown host runtime option')
  const result=await collectHost({native:args.includes('--native'),objectstore:args.includes('--objectstore')})
  await mkdir('.dyoffice-runtime-evidence',{recursive:true});await writeFile('.dyoffice-runtime-evidence/host-runtime.json',JSON.stringify(result,null,2)+'\n')
  console.log('Verified actual Node/PostgreSQL/Redis host runtime and wrote nonsecret manifest')
 }catch(error){console.error('Host runtime admission failed: '+error.message);process.exitCode=1}
}
export function hashCommand(command,args){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['ignore','pipe','ignore']}),digest=createHash('sha256')
  let failure,bytes=0
  const timer=setTimeout(()=>{failure=new Error('Artifact hashing timed out');child.kill('SIGKILL')},30000)
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024*1024){failure=new Error('Artifact exceeds 1 GiB');child.kill('SIGKILL')}else digest.update(chunk)})
  child.stdout.on('error',error=>{failure=error;child.kill('SIGKILL')})
  child.on('error',error=>{clearTimeout(timer);reject(error)})
  child.on('close',code=>{clearTimeout(timer);if(failure||code!==0)reject(failure||new Error('Artifact decompression failed'));else resolve(digest.digest('hex'))})
 })
}
