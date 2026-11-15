import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/application.mjs';

test('personal preferences and admin configuration have separate access boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-'));
  const server = await createApplication({ directory, userToken:'personal', adminToken:'admin', encryptionKey:'test-only-encryption-key' });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, token='personal', body) => fetch(base+path, {method:body?'PUT':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert.equal((await request('/api/preferences','bad')).status,401);
  assert.equal((await request('/api/admin/config')).status,403);
  assert.equal((await request('/api/preferences','personal',{theme:'dark',model:'unauthorized'})).status,400);
  assert.equal((await request('/api/preferences','personal',{theme:'dark',language:'zh'})).status,200);
  assert.equal((await (await request('/api/preferences')).json()).theme,'dark');
  assert.equal((await request('/api/admin/config','admin',{models:[{id:'primary',model:'gpt-4.1',baseUrl:'https://api.openai.com/v1',apiKey:'super-secret',enabled:true}]})).status,200);
  const publicModels = await (await request('/api/models')).json();
  assert.equal(publicModels[0].id,'primary'); assert.equal(JSON.stringify(publicModels).includes('super-secret'),false);
  assert.equal((await readFile(join(directory,'state.json'),'utf8')).includes('super-secret'),false);
  assert.equal((await request('/api/admin/config','admin',{mcp:[{id:'local',transport:'stdio',command:'sh'}]})).status,400);
  assert.equal((await request('/api/admin/config','admin',{mcp:[{id:'remote',transport:'http',url:'https://example.com/mcp'}]})).status,200);
  assert.equal((await request('/api/preferences','personal',{theme:'light'})).status,200);
  const prefs = await (await request('/api/preferences')).json(); assert.equal(prefs.language,'zh');
});

test('imports four allowed formats, rejects other formats and downloads original bytes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-files-'));
  const server=await createApplication({directory,userToken:'personal',adminToken:'admin',encryptionKey:'test'});
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const upload=(name,content)=>fetch(base+'/api/files',{method:'POST',headers:{Authorization:'Bearer personal','X-File-Name':encodeURIComponent(name)},body:content});
  assert.equal((await upload('test.html','<html>')).status,400);
  assert.equal((await upload('fake.pdf','invalid')).status,400);
  assert.equal((await upload('../test.docx','PK data')).status,400);
  for(const ext of ['docx','xlsx','pptx','pdf']){
    const content=ext==='pdf'?'%PDF-1.7 sample':'PK sample';
    const response=await upload('中文.'+ext,content);assert.equal(response.status,201);
    const entry=await response.json();
    const file=await fetch(base+'/api/files/'+entry.id,{headers:{Authorization:'Bearer personal'}});
    assert.equal(await file.text(),content);
  }
  const result=await fetch(base+'/api/files',{headers:{Authorization:'Bearer personal'}});
  assert.equal((await result.json()).length,4);
});

test('persists preferences and encrypted secrets across server restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-persist-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const options={directory,userToken:'personal',adminToken:'admin',encryptionKey:'persistent-test'};
  async function start(){const s=await createApplication(options);s.listen(0,'127.0.0.1');await new Promise(resolve=>s.once('listening',resolve));return s;}
  let server=await start();
  let base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/preferences',{method:'PUT',headers:{Authorization:'Bearer personal','Content-Type':'application/json'},body:JSON.stringify({theme:'dark'})});
  assert.equal(response.status,200);await new Promise(resolve=>server.close(resolve));
  server=await start();t.after(()=>new Promise(resolve=>server.close(resolve)));
  base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await(await fetch(base+'/api/preferences',{headers:{Authorization:'Bearer personal'}})).json()).theme,'dark');
});


test('production refuses the development token server before creating data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-production-'));
  const data = join(directory, 'not-created');
  t.after(() => rm(directory, {recursive:true, force:true}));
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(createApplication({directory:data, userToken:'personal', adminToken:'admin', encryptionKey:'test'}), /development.*token|token.*production/i);
    await assert.rejects(access(data), {code:'ENOENT'});
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('configuration admin cannot read or mutate personal resources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-ownership-'));
  const server = await createApplication({directory, userToken:'personal', adminToken:'admin', encryptionKey:'test'});
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, token, method='GET', body) => fetch(base+path, {method, headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, body:body===undefined?undefined:JSON.stringify(body)});
  const uploaded = await fetch(base+'/api/files', {method:'POST', headers:{Authorization:'Bearer personal', 'X-File-Name':'private.pdf'}, body:'%PDF-1.7 personal bytes'});
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json();
  for (const path of ['/api/files', `/api/files/${file.id}`, '/api/preferences', '/api/sources']) {
    const response = await request(path, 'admin');
    assert.equal(response.status, 403, `admin must not read ${path}`);
    assert.equal(JSON.stringify(await response.json()).includes('private.pdf'), false);
  }
  assert.equal((await request('/api/preferences', 'admin', 'PUT', {theme:'dark'})).status, 403);
  assert.equal((await request('/api/sources', 'admin', 'PUT', {name:'admin source',url:'https://example.com'})).status, 403);
  assert.equal((await fetch(base+'/api/files', {method:'POST', headers:{Authorization:'Bearer admin','X-File-Name':'admin.pdf'}, body:'%PDF-1.7 admin bytes'})).status, 403);
  const personalDownload = await request(`/api/files/${file.id}`, 'personal');
  assert.equal(personalDownload.status, 200);
  assert.equal(await personalDownload.text(), '%PDF-1.7 personal bytes');
  assert.equal((await (await request('/api/files', 'personal')).json()).length, 1);
  assert.equal((await (await request('/api/preferences', 'personal')).json()).theme, 'system');
  assert.deepEqual(await (await request('/api/sources', 'personal')).json(), []);
  assert.equal((await request('/api/preferences', 'personal', 'PUT', {theme:'dark'})).status, 200);
  assert.equal((await request('/api/sources', 'personal', 'PUT', {name:'personal source',url:'https://example.com'})).status, 200);
  assert.equal((await request('/api/admin/config', 'admin')).status, 200);
  assert.equal((await request('/api/admin/config', 'personal')).status, 403);
  assert.equal((await request('/api/models', 'admin')).status, 200);
  assert.equal((await request('/api/models', 'personal')).status, 200);
});

test('concurrent admin sections preserve the other committed section', async t => {
  const {request} = await import('node:http');
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-admin-race-'));
  const server=await createApplication({directory,userToken:'personal',adminToken:'admin',encryptionKey:'test'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const observed=new Promise(resolve=>server.once('request',resolve));
  const slow=request(base+'/api/admin/config',{method:'PUT',headers:{Authorization:'Bearer admin','Content-Type':'application/json'}});
  t.after(()=>slow.destroy());
  const slowResponse=new Promise((resolve,reject)=>{slow.on('error',reject);slow.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});});
  slow.write('{');await observed;
  const mcp={id:'m',transport:'http',url:'https://example.com/',enabled:true,apiKey:'fake-key'};
  const fast=await fetch(base+'/api/admin/config',{method:'PUT',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:JSON.stringify({mcp:[mcp]})});
  assert.equal(fast.status,200);await fast.text();
  slow.end('"models":[{"id":"x","model":"x","baseUrl":"https://example.com/","enabled":true}]}');
  assert.equal(await slowResponse,200);
  const state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
  assert.equal(state.admin.models.length,1);
  assert.equal(state.admin.mcp.length,1);
  assert.equal(state.admin.mcp[0].id,'m');
  assert.ok(state.admin.mcp[0].secret);
});

test('an omitted admin key preserves the latest key committed while the body arrives', async t => {
  const {request}=await import('node:http');
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-admin-key-race-'));
  const server=await createApplication({directory,userToken:'personal',adminToken:'admin',encryptionKey:'test'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const observed=new Promise(resolve=>server.once('request',resolve));
  const slow=request(base+'/api/admin/config',{method:'PUT',headers:{Authorization:'Bearer admin','Content-Type':'application/json'}});
  t.after(()=>slow.destroy());
  const response=new Promise((resolve,reject)=>{slow.on('error',reject);slow.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});});
  slow.write('{');await observed;
  const model={id:'x',model:'x',baseUrl:'https://example.com/',enabled:true};
  const fast=await fetch(base+'/api/admin/config',{method:'PUT',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:JSON.stringify({models:[{...model,apiKey:'fake-new-key'}]})});
  assert.equal(fast.status,200);await fast.text();
  const before=JSON.parse(await readFile(join(directory,'state.json'),'utf8')).admin.models[0].secret;
  slow.end(JSON.stringify({models:[model]}).slice(1));assert.equal(await response,200);
  const after=JSON.parse(await readFile(join(directory,'state.json'),'utf8')).admin.models[0].secret;
  assert.ok(before);assert.equal(after,before);
});
