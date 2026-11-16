import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createApiShell} from '../server/src/framework.ts'
import {registerLocalShell} from '../server/src/local-shell.ts'
test('local login shell serves only built manifest assets, never legacy/admin/source pages',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'local-shell-'));t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(join(directory,'.vite'));await mkdir(join(directory,'assets'))
 await writeFile(join(directory,'index.html'),'<div id="app">local shell</div>');await writeFile(join(directory,'assets/app.js'),'export {}');await writeFile(join(directory,'.vite/manifest.json'),JSON.stringify({'index.html':{file:'assets/app.js'}}))
 const app=await createApiShell();t.after(()=>app.close());await registerLocalShell(app,directory);await app.ready()
 const root=await app.inject('/');assert.equal(root.statusCode,200);assert.match(root.body,/local shell/);assert.match(root.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(root.headers['cache-control'],'private, no-store')
 assert.equal((await app.inject('/assets/app.js')).statusCode,200)
 for(const path of ['/legacy.html','/admin','/src/shell/local-main.tsx','/.vite/manifest.json','/api/v1/preferences','/assets/missing.js'])assert.equal((await app.inject(path)).statusCode,404,path)
 assert.equal((await app.inject({method:'HEAD',url:'/'})).body,'')
})
