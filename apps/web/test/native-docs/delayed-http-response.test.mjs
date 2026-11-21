import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { holdFirstResponseEnd } from '../helpers/delayed-http-response.mjs'

test('hold only the first matching server response and flush its original bytes on release', async t => {
  const held = holdFirstResponseEnd(req => req.method === 'POST' && req.url === '/commits')
  const server = createServer((req,res) => {
    held.intercept(req,res)
    res.writeHead(200,{'content-type':'text/plain'})
    res.end(req.method+' '+req.url)
  })
  const send = (method,path) => new Promise((resolve,reject) => {
    const req = request({host:'127.0.0.1',port:server.address().port,method,path}, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data',chunk => { body += chunk })
      res.on('end',() => resolve(body))
    })
    req.on('error',reject)
    req.end()
  })
  t.after(async () => {
    held.release()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  let firstFinished = false
  const first = send('POST','/commits').finally(() => { firstFinished = true })
  void first.catch(() => {})
  assert.equal(await held.started,200)
  assert.equal(await send('GET','/commits'),'GET /commits')
  assert.equal(await send('POST','/commits'),'POST /commits')
  assert.equal(firstFinished,false)
  held.release()
  held.release()
  assert.equal(await first,'POST /commits')
})

test('release during cleanup does not write to a closed response', async () => {
  const held = holdFirstResponseEnd(() => true)
  let writes = 0
  const res = {statusCode:200,destroyed:false,end(){ writes++ }}
  held.intercept({},res)
  res.end('held')
  assert.equal(await held.started,200)
  res.destroyed = true
  held.release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes,0)
})
