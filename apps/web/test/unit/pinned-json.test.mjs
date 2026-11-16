import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinnedJsonClient } from '../../server/src/security/pinned-json.ts'

test('requires an explicit HTTPS target with exact approved addresses', () => {
 for (const target of [{url:'http://example.com',addresses:['1.2.3.4']},{url:'https://u:p@example.com',addresses:['1.2.3.4']},{url:'https://example.com',addresses:[]},{url:'https://example.com',addresses:['example.com']},{url:'https://169.254.169.254',addresses:['169.254.169.254']}]) assert.throws(()=>createPinnedJsonClient({a:target}),/Invalid egress configuration/)
})
test('unconfigured source and pre-aborted requests fail before connecting',async()=>{
 const client=createPinnedJsonClient({a:{url:'https://example.com',addresses:['1.2.3.4']}})
 await assert.rejects(client.get('b'),/Source request failed/)
 await assert.rejects(client.get('a',AbortSignal.abort()),/Source request failed/)
})
import { createServer } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

test('real TLS connection pins approved address and bounds responses', async t => {
 const dir=mkdtempSync(join(tmpdir(),'pinned-json-'))
 try {
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1'],{stdio:'ignore'})
 const cert=readFileSync(join(dir,'cert.pem'),'utf8'); let calls=0
 const server=createServer({key:readFileSync(join(dir,'key.pem')),cert},(req,res)=>{
  calls++;res.setHeader('content-type','application/json')
  if(req.url==='/redirect'){res.writeHead(302,{location:'/ok'});res.end();return}
  if(req.url==='/hang')return
  if(req.url==='/large'){res.end(JSON.stringify({text:'界'.repeat(1000)}));return}
  if(req.url==='/bad'){res.end('{broken');return}
  if(req.url==='/utf8'){res.end(Buffer.from([0xc3,0x28]));return}
  if(req.url==='/partial'){res.writeHead(200,{'content-length':'50'});res.write('{');setTimeout(()=>res.destroy(),10);return}
  if(req.url==='/gzip'){res.setHeader('content-encoding','gzip');res.end('fake');return}
  res.end(JSON.stringify({value:12.5,unit:'元'}))
 })
 await new Promise(r=>server.listen(0,'::',r)); const port=server.address().port
 t.after(()=>{server.closeAllConnections();server.close()})
 const target=path=>({url:`https://127.0.0.1:${port}${path}`,addresses:['127.0.0.1'],ca:cert})
 const client=createPinnedJsonClient({ok:target('/ok'),redirect:target('/redirect'),hang:target('/hang'),large:target('/large'),bad:target('/bad'),gzip:target('/gzip'),utf8:target('/utf8'),partial:target('/partial')},{timeoutMs:500,maxBytes:1024})
 assert.deepEqual(await client.get('ok'),{value:12.5,unit:'元'})
 const viaDns=createPinnedJsonClient({ok:{...target('/ok'),url:`https://localhost:${port}/ok`,addresses:['127.0.0.1','::1']}})
 assert.deepEqual(await viaDns.get('ok'),{value:12.5,unit:'元'})
 const viaV6=createPinnedJsonClient({ok:{...target('/ok'),url:`https://[::1]:${port}/ok`,addresses:['0:0:0:0:0:0:0:1']}})
 assert.deepEqual(await viaV6.get('ok'),{value:12.5,unit:'元'})
 const controller=new AbortController(); const pending=client.get('hang',controller.signal);setTimeout(()=>controller.abort(),20);await assert.rejects(pending,/Source request failed/)
 const altered=target('/ok');const frozenClient=createPinnedJsonClient({ok:altered});altered.url='https://169.254.169.254';altered.addresses[0]='169.254.169.254';assert.deepEqual(await frozenClient.get('ok'),{value:12.5,unit:'元'})
 const before=calls; await assert.rejects(client.get('redirect'),/Source request failed/); assert.equal(calls,before+1)
 for(const id of ['hang','large','bad','gzip','utf8','partial']) await assert.rejects(client.get(id),/Source request failed/)
 const wrongName=createPinnedJsonClient({ok:{...target('/ok'),url:`https://127.0.0.2:${port}/ok`,addresses:['127.0.0.2']}});await assert.rejects(wrongName.get('ok'),/Source request failed/)
 const untrusted=createPinnedJsonClient({ok:{...target('/ok'),ca:undefined}});await assert.rejects(untrusted.get('ok'),/Source request failed/)
 const wrong=createPinnedJsonClient({ok:{...target('/ok'),addresses:['192.0.2.1']}});await assert.rejects(wrong.get('ok'),/Source request failed/)
 const dnsMismatch=createPinnedJsonClient({ok:{...target('/ok'),url:`https://localhost:${port}/ok`,addresses:['192.0.2.1']}});await assert.rejects(dnsMismatch.get('ok'),/Source request failed/)
 } finally {rmSync(dir,{recursive:true,force:true})}
})
test('rejects IPv6 metadata in normalized and expanded forms',()=>{
 for(const ip of ['fd00:ec2::254','fd00:0ec2:0000:0000:0000:0000:0000:0254']) assert.throws(()=>createPinnedJsonClient({a:{url:`https://[${ip}]/`,addresses:[ip]}}),/Invalid egress configuration/)
})
