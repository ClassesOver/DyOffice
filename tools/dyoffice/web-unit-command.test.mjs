import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, copyFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'web-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'apps/web/test/unit'),{recursive:true});await mkdir(join(root,'tools'),{recursive:true});await copyFile(new URL('../run-web-unit.mjs',import.meta.url),join(root,'tools/run-web-unit.mjs'));for(const [name,fail] of [['alpha',false],['beta',true]])await writeFile(join(root,'apps/web/test/unit',name+'.test.mjs'),`import test from 'node:test'; test('${name}',()=>{${fail?'throw new Error("intentional beta failure")':''}})`);const env={...process.env};delete env.NODE_TEST_CONTEXT;return(...args)=>spawnSync(process.execPath,[join(root,'tools/run-web-unit.mjs'),...args],{cwd:tmpdir(),encoding:'utf8',env})}
test('named selection runs only existing requested test, independent of cwd',async t=>{const run=await fixture(t);const r=run('alpha.test.mjs');assert.equal(r.status,0,r.stderr+r.stdout);assert.match(r.stdout,/alpha/);assert.doesNotMatch(r.stdout,/beta/)});
test('default includes all unit files and propagates actual failing status',async t=>{const run=await fixture(t);const r=run();assert.notEqual(r.status,0);assert.match(r.stdout,/intentional beta failure/)});
test('unknown, traversal and CLI flag selectors fail closed instead of running all',async t=>{const run=await fixture(t);for(const name of ['missing.test.mjs','../alpha.test.mjs','--test-skip-pattern=.*','alpha.test.ts']){const r=run(name);assert.notEqual(r.status,0);assert.match(r.stderr,/unit test selector/);assert.doesNotMatch(r.stdout,/TAP version/)} });
