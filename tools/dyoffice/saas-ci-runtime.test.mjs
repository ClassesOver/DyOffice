import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'

test('SaaS Node entrypoints transform parameter properties before tests or worker startup',async()=>{
 const root=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'))
 const web=JSON.parse(await readFile(new URL('../../apps/web/package.json',import.meta.url),'utf8'))
 const scripts=[root.scripts['test:web:docs'],...['test:e2e','test:storage','test:jobs','test:sandbox','test:native-jobs','start:worker','test:native-sheets'].map(name=>web.scripts[name])]
 const dir=await mkdtemp(join(tmpdir(),'saas-runtime-'))
 try {
  const file=join(dir,'fixture.ts');await writeFile(file,"class Example {constructor(readonly value:number){}};if(new Example(7).value!==7)throw Error('value');")
  for(const command of scripts){
   assert.match(command,/^node --experimental-transform-types /)
   const run=spawnSync(process.execPath,[command.split(' ')[1],file],{encoding:'utf8',timeout:10000})
   assert.equal(run.status,0,run.stderr)
  }
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('native worker CI installs the no-Electron shared workspace required by the gateway',async()=>{
 const text=await readFile(new URL('../../.github/workflows/dyoffice-web-boundaries.yml',import.meta.url),'utf8')
 const job=text.split('  native-worker:')[1].split('  native-sheets:')[0]
 assert.match(job,/run: npm ci --ignore-scripts --include=dev/)
 assert.doesNotMatch(job,/npm ci --prefix apps\/web --workspaces=false/)
 const root=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'))
 assert.ok(root.workspaces.includes('apps/sheets'))
})

test('native Sheets server child uses the same TypeScript transform and resolution as its parent',async()=>{
 const source=await readFile(new URL('../../apps/web/test/native-sheets/runtime.test.mjs',import.meta.url),'utf8')
 assert.match(source,/spawn\(process\.execPath,\['--experimental-transform-types','--import','tsx','server\/index\.mjs'\]/)
 assert.doesNotMatch(source,/--experimental-strip-types/)
})
