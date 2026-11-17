import {open,stat,statfs} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {pathToFileURL} from 'node:url'
const exec=promisify(execFile)
// Diagnostics only: these observations are NOT an authority or capability certificate.
function osField(text,key){
 if(typeof text!=='string')return null
 const rows=text.split('\n').filter(line=>line.startsWith(key+'='))
 if(rows.length!==1)return null
 const match=rows[0].slice(key.length+1).match(/^(?:"([A-Za-z0-9._-]+)"|'([A-Za-z0-9._-]+)'|([A-Za-z0-9._-]+))$/)
 return match ? match[1]??match[2]??match[3] : null
}
const text=value=>typeof value==='string'?value.trim():null
export function evaluatePreflight(input){
 const observations={architecture:input.arch??null,platform:input.platform??null,osId:osField(input.osRelease,'ID'),osVersion:osField(input.osRelease,'VERSION_ID'),pid1:text(input.pid1),systemdVersion:typeof input.systemdVersion==='string'?input.systemdVersion.match(/^systemd ([0-9]+)\b/)?.[1]??null:null,systemBusSocket:input.systemBusSocket===true,selinuxEnforcing:text(input.selinuxEnforce)==='1',cgroupType:input.cgroupType??null,controllers:typeof input.controllers==='string'?input.controllers.trim().split(/\s+/).filter(Boolean):[],kernelRelease:text(input.kernelRelease)}
 const checks={linux:observations.platform==='linux',x86_64:observations.architecture==='x64',openEuler2403:observations.osId==='openEuler'&&observations.osVersion==='24.03',pid1Systemd:observations.pid1==='systemd',systemdVersionObserved:observations.systemdVersion!==null,systemBusSocketPresent:observations.systemBusSocket,selinuxEnforcing:observations.selinuxEnforcing,cgroupV2:observations.cgroupType==='cgroup2',controllersVisible:['cpu','memory','pids'].every(c=>observations.controllers.includes(c)),kernelObserved:!!observations.kernelRelease}
 return {schemaVersion:1,scope:'read-only-preflight',status:'BLOCKED',productionEligible:false,liveAcceptance:'NOT_RUN',prerequisitesSatisfied:Object.values(checks).every(Boolean),observations,checks,blockers:[...Object.entries(checks).filter(([,v])=>!v).map(([k])=>k),'LIVE_ACCEPTANCE_REQUIRED']}
}
async function readBounded(path){
 const file=await open(path,'r')
 try{const b=Buffer.alloc(16385);let n=0;while(n<b.length){const r=await file.read(b,n,b.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead}if(n>16384)throw Error('oversize');return b.subarray(0,n).toString('utf8')}finally{await file.close()}
}
const defaults={arch:process.arch,platform:process.platform,read:readBounded,socket:async path=>(await stat(path)).isSocket(),version:async()=>(await exec('/usr/bin/systemctl',['--version'],{timeout:2000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',LANG:'C',SYSTEMD_COLORS:'0',SYSTEMD_PAGER:'cat'}})).stdout,cgroupType:async()=>(await statfs('/sys/fs/cgroup')).type===0x63677270?'cgroup2':'other'}
export async function collectPreflight(io=defaults){
 const safely=async task=>{try{return await task()}catch{return null}}
 const [osRelease,pid1,kernelRelease,selinuxEnforce,controllers,systemBusSocket,systemdVersion,cgroupType]=await Promise.all([
 ...['/etc/os-release','/proc/1/comm','/proc/sys/kernel/osrelease','/sys/fs/selinux/enforce','/sys/fs/cgroup/cgroup.controllers'].map(p=>safely(()=>io.read(p))),
 safely(()=>io.socket('/run/dbus/system_bus_socket')),safely(()=>io.version()),safely(()=>io.cgroupType())])
 return evaluatePreflight({arch:io.arch,platform:io.platform,osRelease,pid1,kernelRelease,selinuxEnforce,controllers,systemBusSocket,systemdVersion,cgroupType})
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==2){console.error('Usage: node tools/document-runtime/preflight-x86_64.mjs');process.exitCode=64}
 else{console.log(JSON.stringify(await collectPreflight(),null,2));process.exitCode=2}
}
