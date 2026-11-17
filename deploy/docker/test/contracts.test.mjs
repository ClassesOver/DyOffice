import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,copyFileSync,rmSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
const here=fileURLToPath(new URL('../',import.meta.url)),root=resolve(here,'../..')
const read=name=>readFileSync(join(here,name),'utf8')
test('HTTP defaults to loopback and retains default secure session policy',()=>{
 const compose=read('compose.yaml')
 assert.ok(compose.includes('${BIND_IP:-127.0.0.1}:${HTTP_PORT:-3080}:3080'))
 assert.ok(compose.includes('DYOFFICE_ORIGIN: ${DYOFFICE_ORIGIN:-http://localhost:3080}'))
 assert.doesNotMatch(compose,/NGINX_IMAGE|443:|privileged:/)
 const csrf=readFileSync(join(root,'apps/web/server/src/modules/auth/csrf.ts'),'utf8')
 assert.match(csrf,/__Host-dyoffice-session/)
 assert.match(csrf,/HttpOnly; Secure; SameSite=Lax/)
 const startup=readFileSync(join(root,'apps/web/server/index.mjs'),'utf8')
 assert.match(startup,/NODE_ENV\s*===\s*'production'/)
})
test('insecure development mode is explicit and off by default',()=>{
 assert.ok(read('compose.yaml').includes('DYOFFICE_INSECURE_HTTP_DEV: ${DYOFFICE_INSECURE_HTTP_DEV:-0}'))
 assert.match(read('.env.example'),/^DYOFFICE_INSECURE_HTTP_DEV=0$/m)
})
test('lock rewriting preserves all versions and integrity and uses configured HTTPS mirror',()=>{
 const temp=mkdtempSync(join(tmpdir(),'dyoffice-lock-'))
 try{
  copyFileSync(join(root,'package-lock.json'),join(temp,'package-lock.json'))
  const before=JSON.parse(readFileSync(join(temp,'package-lock.json'),'utf8'))
  const result=spawnSync(process.execPath,[join(here,'rewrite-lock.mjs')],{cwd:temp,env:{...process.env,NPM_REGISTRY:'https://repo.huaweicloud.com/repository/npm/'},encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  const after=JSON.parse(readFileSync(join(temp,'package-lock.json'),'utf8'))
  let count=0
  for(const [name,entry] of Object.entries(before.packages)){
   const rewritten=after.packages[name]
   if(entry.resolved&&!entry.link){assert.match(rewritten.resolved,/^https:\/\/repo\.huaweicloud\.com\/repository\/npm\//);count++}
   const {resolved,...left}=entry,{resolved:ignored,...right}=rewritten
   assert.deepEqual(right,left)
  }
  assert.ok(count>1000)
 }finally{rmSync(temp,{recursive:true,force:true})}
})
test('secrets excluded from build; worker has no owner/auth credential; AI opt-in only',()=>{
 assert.match(read('Dockerfile.dockerignore'),/\*\*\/secrets/)
 assert.match(read('Dockerfile.dockerignore'),/\*\*\/\*\.env/)
 assert.doesNotMatch(read('host/worker.env.example'),/DYOFFICE_(AUTH_)?DATABASE_URL=/)
 assert.doesNotMatch(read('compose.yaml'),/DYOFFICE_PROVIDER_GATEWAY_PROFILES/)
 assert.match(read('compose.ai.yaml'),/DYOFFICE_PROVIDER_GATEWAY_PROFILES/)
 assert.match(read('compose.yaml'),/DYOFFICE_CODING_AGENT: 'off'/)
})
test('required environment template is tracked for clean-clone secret generation',()=>{
 const result=spawnSync('git',['ls-files','--error-unmatch','deploy/docker/.env.example'],{cwd:root,encoding:'utf8'})
 assert.equal(result.status,0,'The non-secret .env.example must be tracked, not only present locally: '+result.stderr)
 const ignored=spawnSync('git',['check-ignore','--no-index','deploy/docker/.env.example'],{cwd:root,encoding:'utf8'})
 assert.equal(ignored.status,1,'The local ignore exception must override the root .env.* rule')
 assert.match(read('.env.example'),/^NODE_IMAGE=/m)
 assert.match(read('.env.example'),/^POSTGRES_IMAGE=/m)
})
