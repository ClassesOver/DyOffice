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
 const root=await app.inject('/');assert.equal(root.statusCode,200);assert.match(root.body,/local shell/);assert.match(root.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(root.headers['cache-control'],'private, no-store');assert.match(root.headers['content-security-policy'],/frame-src 'self'/)
 assert.equal((await app.inject('/assets/app.js')).statusCode,200)
 for(const path of ['/legacy.html','/admin','/src/shell/local-main.tsx','/.vite/manifest.json','/api/v1/preferences','/assets/missing.js','/pdfjs/standard_fonts/LiberationSans-Regular.ttf','/pdfjs/cmaps/UniGB-UCS2-H.bcmap'])assert.equal((await app.inject(path)).statusCode,404,path)
 assert.equal((await app.inject({method:'HEAD',url:'/'})).body,'')
})

test('local shell reloads its allowlist after a rebuild without restarting the server',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'local-shell-rebuild-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 await mkdir(join(directory,'.vite'));await mkdir(join(directory,'assets'))
 const build=async name=>{
  await writeFile(join(directory,'assets',name),`export const build=${JSON.stringify(name)}`)
  await writeFile(join(directory,'index.html'),`<script type="module" src="/assets/${name}"></script>`)
  await writeFile(join(directory,'.vite/manifest.json'),JSON.stringify({'index.html':{file:'assets/'+name}}))
 }
 await build('old.js')
 const app=await createApiShell();t.after(()=>app.close());await registerLocalShell(app,directory);await app.ready()
 assert.equal((await app.inject('/assets/old.js')).statusCode,200)
 await build('new-build.js')
 await writeFile(join(directory,'assets/private.js'),'not in the build manifest')
 assert.match((await app.inject('/')).body,/new-build.js/)
 const script=await app.inject('/assets/new-build.js')
 assert.equal(script.statusCode,200);assert.match(script.headers['content-type'],/javascript/)
 assert.match(script.body,/new-build.js/)
 assert.equal((await app.inject('/assets/private.js')).statusCode,404)
 assert.equal((await app.inject('/assets/old.js')).statusCode,404)
 assert.equal((await app.inject({method:'HEAD',url:'/assets/new-build.js'})).body,'')
 await build('third-build.js')
 assert.equal((await app.inject('/assets/third-build.js')).statusCode,200)
})

for(const embedOrigin of ['http://localhost:3080','http://127.0.0.1:3080'])test(`only the explicit embed page allows DSH embedding: ${embedOrigin}`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'local-shell-dsh-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 await mkdir(join(directory,'.vite'))
 await mkdir(join(directory,'assets'))
 await writeFile(join(directory,'index.html'),'<div id="app">local shell</div>')
 await writeFile(join(directory,'assets/app.js'),'export {}')
 await writeFile(join(directory,'.vite/manifest.json'),JSON.stringify({'index.html':{file:'assets/app.js'}}))
 const app=await createApiShell();t.after(()=>app.close())
 let allowed=[embedOrigin]
 await registerLocalShell(app,directory,async()=>allowed)
 const ancestors=async url=>(await app.inject(url)).headers['content-security-policy']?.split('; ').at(-1)
 assert.equal(await ancestors('/'),'frame-ancestors \'none\'')
 assert.equal(await ancestors('/?dshEmbed=0'),'frame-ancestors \'none\'')
 assert.equal(await ancestors('/?dshEmbed=1'),'frame-ancestors '+embedOrigin)
 assert.equal(await ancestors('/?dshEmbed=1&origin=https://other.test'),'frame-ancestors '+embedOrigin)
 allowed=['http://localhost:3080','http://127.0.0.1:3080']
 assert.equal(await ancestors('/?dshEmbed=1'),'frame-ancestors '+allowed.join(' '))
 allowed=[]
 assert.equal(await ancestors('/?dshEmbed=1'),"frame-ancestors 'none'")
})
