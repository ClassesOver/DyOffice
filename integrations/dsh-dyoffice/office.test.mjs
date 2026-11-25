import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {connectOffice,storeOfficeToken} from './office.js'

test('connects with one authorization code and still accepts a legacy token with its origin',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dsh-dyoffice-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  const server=createServer((request,response)=>{
    assert.equal(request.url,'/api/v1/assistant-channels/member')
    assert.equal(request.headers.authorization,'Bearer example-token')
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({conversationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',member:{membershipId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const origin='http://127.0.0.1:'+server.address().port
  const memberFile=join(directory,'token.json')
  const config={origin:'https://configured.example',memberFile}
  await storeOfficeToken(origin+'/#dsh=example-token',undefined,config)
  assert.deepEqual(JSON.parse(await readFile(memberFile,'utf8')),{token:'example-token',origin})
  const office=await connectOffice(undefined,config)
  assert.equal(office.origin,origin)
  assert.equal(office.conversationId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  await storeOfficeToken('example-token',origin,config)
  assert.equal((await connectOffice(undefined,config)).origin,origin)
})

test('rejects non-HTTPS remote DyOffice URLs before contacting them',async()=>{
  const {officeOrigin}=await import('./office.js')
  assert.throws(()=>officeOrigin('http://example.invalid'),/HTTPS origin or a loopback HTTP origin/)
  assert.throws(()=>officeOrigin('https://example.invalid/path'),/HTTPS origin or a loopback HTTP origin/)
})
