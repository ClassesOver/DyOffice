import {test} from 'node:test'
import assert from 'node:assert/strict'
import {evaluatePreflight, collectPreflight} from './preflight-x86_64.mjs'
const good=()=>({arch:'x64',platform:'linux',osRelease:'ID="openEuler"\nVERSION_ID="24.03"',pid1:'systemd\n',systemdVersion:'systemd 252 (252-1)\n+SELINUX +SECCOMP',systemBusSocket:true,selinuxEnforce:'1\n',cgroupType:'cgroup2',controllers:'cpu memory pids io',kernelRelease:'6.6-test'})
test('static prerequisites never certify execution',()=>{const r=evaluatePreflight(good());assert.equal(r.prerequisitesSatisfied,true);assert.equal(r.status,'BLOCKED');assert.equal(r.productionEligible,false);assert.equal(r.liveAcceptance,'NOT_RUN')})
for(const [field,value] of [['arch','arm64'],['platform','darwin'],['osRelease','ID=debian'],['pid1','codex'],['systemdVersion','unknown'],['systemBusSocket',false],['selinuxEnforce','0'],['cgroupType','tmpfs'],['controllers','cpu memory'],['kernelRelease',null]])test(`missing prerequisite ${field} blocks`,()=>{const r=evaluatePreflight({...good(),[field]:value});assert.equal(r.prerequisitesSatisfied,false)})
test('installed systemctl cannot compensate for missing manager',()=>assert.equal(evaluatePreflight({...good(),pid1:'codex',systemBusSocket:false}).prerequisitesSatisfied,false))
test('duplicate OS keys and missing versions do not pass',()=>{for(const osRelease of ['ID=openEuler\nID=debian\nVERSION_ID=24.03','ID=ubuntu'])assert.equal(evaluatePreflight({...good(),osRelease}).prerequisitesSatisfied,false)})
test('collector only uses bounded fixed read/stat/version probes',async()=>{const calls=[];const r=await collectPreflight({arch:'x64',platform:'linux',read:async p=>{calls.push(['read',p]);throw Error('denied')},socket:async p=>{calls.push(['socket',p]);return false},version:async()=>{calls.push(['version']);throw Error('missing')},cgroupType:async()=>null});assert.equal(r.status,'BLOCKED');assert.equal(r.prerequisitesSatisfied,false);assert.deepEqual(calls.filter(x=>x[0]==='socket'),[['socket','/run/dbus/system_bus_socket']]);assert.equal(calls.filter(x=>x[0]==='version').length,1);assert.ok(calls.every(x=>['read','socket','version'].includes(x[0])))})
test('unknown/unreadable facts and spoofed version text never satisfy prerequisites',()=>{for(const systemdVersion of [null,'banner\nsystemd 252','systemd unknown'])assert.equal(evaluatePreflight({...good(),systemdVersion}).prerequisitesSatisfied,false)})
test('fixture collector reaches evaluator using only expected paths',async()=>{const g=good(),paths=[];const files={'/etc/os-release':g.osRelease,'/proc/1/comm':g.pid1,'/proc/sys/kernel/osrelease':g.kernelRelease,'/sys/fs/selinux/enforce':g.selinuxEnforce,'/sys/fs/cgroup/cgroup.controllers':g.controllers};const r=await collectPreflight({arch:g.arch,platform:g.platform,read:async p=>{paths.push(p);return files[p]},socket:async()=>true,version:async()=>g.systemdVersion,cgroupType:async()=>g.cgroupType});assert.equal(r.prerequisitesSatisfied,true);assert.deepEqual(paths,Object.keys(files));assert.equal(r.productionEligible,false)})

test('both requested distributions record actual versions without granting certification',()=>{
 for(const [id,version] of [['openEuler','24.03'],['openEuler','22.03'],['ubuntu','24.04'],['ubuntu','22.04']]){
  const r=evaluatePreflight({...good(),osRelease:`ID=${id}\nVERSION_ID=${version}`})
  assert.equal(r.prerequisitesSatisfied,true);assert.equal(r.observations.osId,id);assert.equal(r.observations.osVersion,version)
  assert.equal(r.status,'BLOCKED');assert.equal(r.productionEligible,false);assert.equal(r.liveAcceptance,'NOT_RUN')
 }
 for(const id of ['debian','Ubuntu','fedora'])assert.equal(evaluatePreflight({...good(),osRelease:`ID=${id}\nVERSION_ID=24.04`}).prerequisitesSatisfied,false)
 for(const id of ['ubuntu','openEuler'])assert.equal(evaluatePreflight({...good(),arch:'arm64',osRelease:`ID=${id}\nVERSION_ID=24.04`}).prerequisitesSatisfied,false)
})
