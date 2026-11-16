import {readdir,lstat,rm} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
// Longest supported native wall time is 180s; allow preparation and shutdown.
const minimumAge=240_000
export async function recoverHostProcesses(deploymentId:string):Promise<number>{
  if(!new RegExp('^'+uuid+'$').test(deploymentId))throw new Error('Invalid deployment')
  if(process.getuid?.()!==0)throw new Error('Host recovery requires service privilege')
  const owned=new RegExp('^dyoffice-'+deploymentId+'-'+uuid+'$')
  const ctl=(args:string[])=>exec('/usr/bin/systemctl',args,{timeout:5000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}})
  let removed=0
  for(const name of await readdir('/var/tmp')){
    if(!owned.test(name))continue
    const path='/var/tmp/'+name,unit=name+'.service'
    const before=await lstat(path).catch(()=>undefined)
    if(!before?.isDirectory()||before.uid!==0||(before.mode&0o077)!==0||Date.now()-before.mtimeMs<minimumAge)continue
    const output=(await ctl(['show',unit,'--property=LoadState,ActiveState,MainPID'])).stdout
    const state=Object.fromEntries(output.trim().split('\n').map(line=>line.split('=')))
    if(state.MainPID!=='0'||!['inactive','failed'].includes(state.ActiveState))continue
    // Recheck inode: another controller/reaper may have removed/replaced it.
    const after=await lstat(path).catch(()=>undefined)
    if(!after||after.ino!==before.ino||after.dev!==before.dev||after.mtimeMs!==before.mtimeMs)continue
    if(state.LoadState!=='not-found')await ctl(['reset-failed',unit])
    await rm(path,{recursive:true,force:true});removed++
  }
  return removed
}
