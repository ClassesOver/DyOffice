import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApplication } from './helpers/prototype-http.mjs';
async function fixture(t) {
  const directory=await mkdtemp('/tmp/dyoffice-problem-');
  const server=await createApplication({directory,userToken:'personal',adminToken:'admin',encryptionKey:'test-key'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
  return `http://127.0.0.1:${server.address().port}`;
}
test('legacy errors retain error/status and gain consistent safe Problem fields',async t=>{
  const base=await fixture(t);
  for(const [path,token,status,error] of [['/api/preferences','bad',401,'请登录'],['/api/admin/config','personal',403,'需要管理员权限'],['/api/missing?secret=private','personal',404,'接口不存在']]) {
    const r=await fetch(base+path,{headers:{authorization:`Bearer ${token}`,'x-request-id':'untrusted-secret'}});
    assert.equal(r.status,status);assert.match(r.headers.get('content-type'),/^application\/json/);
    const value=await r.json();assert.equal(value.error,error);assert.equal(value.status,status);
    assert.equal(value.type,'about:blank');assert.equal(typeof value.title,'string');assert.equal(value.detail,error);
    assert.match(value.requestId,/^[0-9a-f-]{36}$/);assert.equal(r.headers.get('x-request-id'),value.requestId);
    assert.equal(JSON.stringify(value).includes('private'),false);assert.equal(JSON.stringify(value).includes('untrusted-secret'),false);
  }
});
test('success body stays unchanged and every request receives a unique server request ID',async t=>{
  const base=await fixture(t);const ids=[];
  for(let n=0;n<2;n++) {const r=await fetch(base+'/api/preferences',{headers:{authorization:'Bearer personal'}});assert.deepEqual(await r.json(),{theme:'system',language:'zh'});ids.push(r.headers.get('x-request-id'));}
  assert.match(ids[0],/^[0-9a-f-]{36}$/);assert.notEqual(ids[0],ids[1]);
});
test('validation and static errors use the same envelope',async t=>{
  const base=await fixture(t);
  const invalid=await fetch(base+'/api/preferences',{method:'PUT',headers:{authorization:'Bearer personal'},body:'{'});
  assert.equal(invalid.status,400);const problem=await invalid.json();assert.equal(problem.status,400);assert.equal(problem.error,'JSON 格式无效');assert.equal(problem.requestId,invalid.headers.get('x-request-id'));
  const missing=await fetch(base+'/nonexistent');assert.equal(missing.status,404);const absent=await missing.json();assert.equal(absent.status,404);assert.equal(absent.requestId,missing.headers.get('x-request-id'));
});
test('read-only v1 route errors also use Problem fields',async t=>{
  const base=await fixture(t);
  for(const [path,method,status] of [['/api/v1/capabilities','POST',405],['/api/v1/files/00000000-0000-4000-8000-000000000000','GET',404]]) {
    const response=await fetch(base+path,{method,headers:{authorization:'Bearer personal'}});
    assert.equal(response.status,status);const value=await response.json();assert.equal(value.status,status);assert.equal(value.requestId,response.headers.get('x-request-id'));assert.equal(typeof value.error,'string');
  }
});
test('revision conflict preserves its machine-readable legacy code',async t=>{
  const base=await fixture(t);const headers={authorization:'Bearer personal'};
  const upload=await fetch(base+'/api/files',{method:'POST',headers:{...headers,'x-file-name':'test.pdf'},body:'%PDF-fixture'});
  const file=await upload.json();
  const response=await fetch(`${base}/api/v1/files/${file.id}/content?revision=stale`,{headers});
  assert.equal(response.status,409);const value=await response.json();assert.equal(value.code,'REVISION_CONFLICT');assert.equal(value.status,409);assert.equal(value.requestId,response.headers.get('x-request-id'));
});
