import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:net'
import {Client} from 'pg'
import {safeFailure} from '../../server/src/modules/sources/sql.ts'

test('StarRocks without TLS has a specific safe connection failure', () => {
 assert.throws(() => safeFailure({code:'HANDSHAKE_NO_SSL_SUPPORT',message:'private connection details'}, 'starrocks'),
  error => error.statusCode === 502 && error.code === 'SOURCE_TLS_UNSUPPORTED' && !error.message.includes('private'))
})

// Use the actual installed pg driver against a synthetic local protocol peer.
// The peer authenticates but never answers a query, exercising its own timer.
test('real pg query read timeout is a gateway timeout, without exposing query or target', async t => {
 const sockets = new Set()
 const server = createServer(socket => {
  sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{})
  let started = false
  socket.on('data',()=>{
   if(started) return
   started=true
   socket.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]))
  })
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))})
 const client=new Client({host:'127.0.0.1',port:server.address().port,user:'fixture',password:'fixture',database:'fixture',query_timeout:40})
 t.after(()=>client.end()); await client.connect()
 await assert.rejects(client.query('SELECT 1'), error=>{
  assert.equal(error.message,'Query read timeout');assert.equal(error.code,undefined)
  assert.throws(()=>safeFailure(error, 'postgres'), mapped=>mapped.statusCode===504 && !mapped.message.includes('SELECT'))
  return true
 })
})

test('SQL failure classification preserves permission denial and unknown failures',()=>{
 for(const code of ['42501','25006','ER_TABLEACCESS_DENIED_ERROR'])assert.throws(()=>safeFailure({code}, 'postgres'),e=>e.statusCode===403)
 for(const code of ['57014','ETIMEDOUT','ER_QUERY_TIMEOUT'])assert.throws(()=>safeFailure({code}, 'postgres'),e=>e.statusCode===504)
 for(const error of [new Error('unrecognized SQL error'),{message:'Query read timeout'},new Error('Query read timeout: credentials')])assert.throws(()=>safeFailure(error, 'postgres'),e=>e.statusCode===502)
})

test('pg-specific driver timeout is not applied to other SQL connectors',()=>{
 for(const kind of ['mysql','starrocks'])assert.throws(()=>safeFailure(new Error('Query read timeout'),kind),e=>e.statusCode===502)
})

test('statement errors reported by the database map to a fixable 400, not an unusable source', () => {
 for(const [kind,code] of [['postgres','42P01'],['postgres','42703'],['postgres','42883'],['postgres','22012'],['mysql','ER_BAD_FIELD_ERROR'],['starrocks','ER_PARSE_ERROR']])
  assert.throws(()=>safeFailure({code,message:'relation "secret_table" does not exist'},kind),e=>e.statusCode===400&&!e.message.includes('secret_table'),code)
 // Privilege errors keep their own mapping.
 assert.throws(()=>safeFailure({code:'42501'},'postgres'),e=>e.statusCode===403)
})
