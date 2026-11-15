import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/application.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-request-errors-'));
  const server=await createApplication({directory,userToken:'test-personal',adminToken:'test-admin',encryptionKey:'test-only-key'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:'Bearer test-personal','Content-Type':'application/json'};
  return {server,base,headers};
}

test('malformed and oversized preference requests return errors without mutating state',{timeout:10_000},async t=>{
  const {base,headers}=await fixture(t);
  const initial=await (await fetch(base+'/api/preferences',{headers})).json();
  for(const [body,status] of [['{',400],['null',400],['[]',400],['x'.repeat(1024*1024+100),413]]) {
    const response=await fetch(base+'/api/preferences',{method:'PUT',headers,body});
    assert.equal(response.status,status);
    assert.match(response.headers.get('content-type'),/application\/json/);
    assert.equal(typeof (await response.json()).error,'string');
    const next=await fetch(base+'/api/preferences',{headers});
    assert.equal(next.status,200);
    assert.deepEqual(await next.json(),initial);
  }
  const valid=await fetch(base+'/api/preferences',{method:'PUT',headers,body:JSON.stringify({theme:'dark'})});
  assert.equal(valid.status,200);
  assert.equal((await valid.json()).theme,'dark');
});

test('aborted partial JSON request does not mutate preferences or break the next request',{timeout:10_000},async t=>{
  const {server,base,headers}=await fixture(t);
  let reachedServer;
  const received=new Promise(resolve=>{reachedServer=resolve;});
  server.once('request',req=>{req.once('data',()=>reachedServer(req));});
  const outgoing=httpRequest(base+'/api/preferences',{method:'PUT',headers:{...headers,'Content-Length':'1000'}});
  t.after(()=>outgoing.destroy());
  outgoing.on('error',()=>{}); // Intentional disconnect, not an application failure.
  outgoing.write('{"theme":"dark"');
  const incoming=await received;
  const closed=new Promise(resolve=>incoming.once('close',resolve));
  outgoing.destroy();
  await closed;
  const response=await fetch(base+'/api/preferences',{headers});
  assert.equal(response.status,200);
  assert.equal((await response.json()).theme,'system');
  const valid=await fetch(base+'/api/preferences',{method:'PUT',headers,body:JSON.stringify({theme:'light'})});
  assert.equal(valid.status,200);
  assert.equal((await valid.json()).theme,'light');
});
