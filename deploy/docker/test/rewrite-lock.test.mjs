import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const script = new URL('../rewrite-lock.mjs', import.meta.url).pathname;
const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
const fixture = () => ({lockfileVersion:3, packages:{'':{name:'test'},'node_modules/pkg':{version:'1.2.3',resolved:'https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz',integrity}}});
function run(lock, registry, raw = false) {
  const dir=mkdtempSync(join(tmpdir(),'dyoffice-lock-'));
  const before=raw ? lock : JSON.stringify(lock);
  try {
    writeFileSync(join(dir,'package-lock.json'),before);
    const env={...process.env}; delete env.NPM_REGISTRY;
    if(registry!==undefined)env.NPM_REGISTRY=registry;
    const result=spawnSync(process.execPath,[script],{cwd:dir,env,encoding:'utf8'});
    return {...result,before,after:readFileSync(join(dir,'package-lock.json'),'utf8')};
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('default Huawei replaces only source, preserving integrity/version',()=>{
  const lock=fixture(), r=run(lock); assert.equal(r.status,0,r.stderr);
  lock.packages['node_modules/pkg'].resolved='https://repo.huaweicloud.com/repository/npm/pkg/-/pkg-1.2.3.tgz';
  assert.deepEqual(JSON.parse(r.after),lock);
});
for(const registry of ['http://mirror.example/','https://user:SECRET@mirror.example/','https://mirror.example/?token=SECRET','https://mirror.example/#SECRET'])test('reject unsafe mirror '+registry.split(':')[0],()=>{
  const r=run(fixture(),registry); assert.notEqual(r.status,0); assert.equal(r.after,r.before); assert.ok(!r.stderr.includes('SECRET'));
});
for(const resolved of ['https://user:SECRET@registry.npmjs.org/pkg/-/pkg.tgz','https://registry.npmjs.org:8443/pkg/-/pkg.tgz','https://registry.npmjs.org/pkg/-/pkg.tgz?SECRET','https://registry.npmjs.org/pkg/-/pkg.tgz#SECRET','git+https://SECRET@example.com/pkg','https://evil.example/pkg'])test('reject unsafe locked URL',()=>{
 const lock=fixture();lock.packages['node_modules/pkg'].resolved=resolved;
 const r=run(lock);assert.notEqual(r.status,0);assert.equal(r.after,r.before);assert.ok(!r.stderr.includes('SECRET'));
});
for(const value of [undefined,'','sha1-deadbeef','sha512-bad'])test('require valid sha512 integrity',()=>{
 const lock=fixture();lock.packages['node_modules/pkg'].integrity=value;
 const r=run(lock);assert.notEqual(r.status,0);assert.equal(r.after,r.before);
});
test('repeat rewrite is idempotent',()=>{
 const first=run(fixture()); const second=run(JSON.parse(first.after)); assert.equal(second.status,0,second.stderr);assert.equal(second.after,first.after);
});
test('explicit upstream override',()=>{const r=run(fixture(),'https://registry.npmjs.org/');assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.after),fixture());});
test('workspace links unchanged',()=>{const lock=fixture();lock.packages['node_modules/local']={link:true,resolved:'packages/local'};lock.packages['packages/local']={name:'local'};const r=run(lock);assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.after).packages['node_modules/local'],lock.packages['node_modules/local']);});
test('remote package missing resolved rejected',()=>{const lock=fixture();delete lock.packages['node_modules/pkg'].resolved;const r=run(lock);assert.notEqual(r.status,0);assert.equal(r.after,r.before);});
test('late rejection never partially writes the file',()=>{const lock=fixture();lock.packages['node_modules/bad']={version:'1',resolved:'https://evil.example/bad.tgz',integrity};const r=run(lock);assert.notEqual(r.status,0);assert.equal(r.after,r.before);});
test('custom HTTPS mirror retains its path prefix',()=>{const r=run(fixture(),'https://mirror.example:8443/npm/');assert.equal(r.status,0);assert.equal(JSON.parse(r.after).packages['node_modules/pkg'].resolved,'https://mirror.example:8443/npm/pkg/-/pkg-1.2.3.tgz');});

for (const raw of ['{"SECRET_TOKEN": nope}', '{"packages":{"token":"SECRET_TOKEN"', 'SECRET_TOKEN']) test('malformed JSON never leaks raw contents or changes lock',()=>{
 const r=run(raw,undefined,true);assert.notEqual(r.status,0);assert.equal(r.after,raw);assert.ok(!r.stderr.includes('SECRET_TOKEN'));assert.ok(!r.stdout.includes('SECRET_TOKEN'));assert.match(r.stderr,/Invalid dependency source or integrity/);
});
