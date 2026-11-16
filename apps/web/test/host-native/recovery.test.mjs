import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,utimes,lstat,rm,symlink} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
test('recovery removes only expired private roots belonging to this deployment',async()=>{
  const {recoverHostProcesses}=await import('../../worker/src/sandbox/host-recovery.ts')
  const deployment=randomUUID(),other=randomUUID(),prefix='/var/tmp/dyoffice-'
  const expired=prefix+deployment+'-'+randomUUID(),fresh=prefix+deployment+'-'+randomUUID(),foreign=prefix+other+'-'+randomUUID(),link=prefix+deployment+'-'+randomUUID()
  try{
    for(const path of [expired,fresh,foreign])await mkdir(path,{mode:0o700})
    const old=new Date(Date.now()-300000);for(const path of [expired,foreign])await utimes(path,old,old)
    await symlink(foreign,link)
    assert.equal(await recoverHostProcesses(deployment),1)
    await assert.rejects(()=>lstat(expired),{code:'ENOENT'})
    for(const path of [fresh,foreign,link])assert.ok(await lstat(path))
    await assert.rejects(()=>recoverHostProcesses('../'),/Invalid deployment/)
  }finally{for(const path of [expired,fresh,foreign,link])await rm(path,{recursive:true,force:true})}
})

test('recovery preserves an expired directory while its exact native unit is still active',async()=>{
  const {recoverHostProcesses}=await import('../../worker/src/sandbox/host-recovery.ts')
  const deployment=randomUUID(),name='dyoffice-'+deployment+'-'+randomUUID(),path='/var/tmp/'+name
  try{
    await mkdir(path,{mode:0o700});const old=new Date(Date.now()-300000);await utimes(path,old,old)
    await exec('/usr/bin/systemd-run',['--quiet','--collect','--unit='+name,'--property=RuntimeMaxSec=30','/usr/bin/sleep','25'])
    assert.equal(await recoverHostProcesses(deployment),0);assert.ok(await lstat(path))
    const state=await exec('/usr/bin/systemctl',['show',name+'.service','--property=ActiveState','--value']);assert.equal(state.stdout.trim(),'active')
  }finally{await exec('/usr/bin/systemctl',['stop',name+'.service']).catch(()=>{});await rm(path,{recursive:true,force:true})}
})
