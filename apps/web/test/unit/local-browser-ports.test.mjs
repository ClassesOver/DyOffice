import test from 'node:test'
import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'

const loopbackOrigin = /https?:\/\/(?:localhost|127\.0\.0\.1):/.source
const originFrom = expression => new RegExp(loopbackOrigin + `(?:['"]\\s*\\+\\s*${expression}|\\$\\{\\s*${expression}\\s*\\})`)

// Fixed origins must stay distinct between files. Fixtures can also bind port 0
// and derive their origin from that same live server before constructing CSRF/CSP services.
export function assertDistinctFixturePorts(sources) {
 const owners = new Map()
 for (const [name, source] of sources) {
  const origins = [...source.matchAll(new RegExp(loopbackOrigin + '(\\d+)', 'g'))].map(m => Number(m[1]))
  const serves = [...source.matchAll(/\bserve\(t,\s*(\d+)/g)].map(m => Number(m[1]))
  const ports = new Set([...origins, ...serves])
  if (originFrom('port\\b').test(source)) {
   const declared = source.match(/\bconst\s+port\s*=\s*(?:(\d+)\b|\w+\s*\?\s*(\d+)\s*:\s*(\d+)\b|Number\(process\.env\.\w+\s*\?\?\s*(\d+)\s*\))/)
   for (const port of declared?.slice(1) ?? []) if (port !== undefined) ports.add(Number(port))
  }
  const allocated = [...source.matchAll(/\b([A-Za-z_]\w*)\.listen\(\s*0\s*,/g)].some(([, server]) => originFrom(server + '\\.address\\(\\)\\.port\\b').test(source))
  // 纯内联 DOM 页面没有服务端；含监听、服务构建或导航的 fixture 仍必须声明端口。
  const inlineDom = /\.setContent\s*\(/.test(source) && /\.addScriptTag\s*\(\s*\{\s*content\s*:/.test(source)
  if (!ports.size && inlineDom && !/\.(?:listen|goto)\s*\(|\b(?:serve|buildLocalApp)\s*\(/.test(source)) continue
  assert.ok(ports.size || allocated, `No declared fixture port found in ${name}`)
  for (const match of source.matchAll(/\.listen\(\s*\{[^}\n]*?\bport:\s*(\d+)/g)) {
   assert.ok(ports.has(Number(match[1])), `${name}: listener differs from its security origin`)
  }
  for (const port of ports) {
   assert.ok(port >= 1024 && port <= 65535, `${name}: invalid fixture port ${port}`)
   assert.ok(!owners.has(port), `Port ${port} is shared by ${owners.get(port)} and ${name}`)
   owners.set(port, name)
  }
 }
 return owners
}

test('concurrent local browser files use distinct origins and listener ports', async () => {
 const directory = new URL('../local-browser/', import.meta.url)
 const names = (await readdir(directory)).filter(name => name.endsWith('.test.mjs'))
 const sources = await Promise.all(names.map(async name => [name, await readFile(new URL(name, directory), 'utf8')]))
 assertDistinctFixturePorts(sources)
})
test('fixture port guard rejects collisions and mismatched security origins', () => {
 assert.throws(() => assertDistinctFixturePorts([['a', "'http://localhost:4201'"], ['b', 'serve(t, 4201)']]), /Port 4201 is shared/)
 assert.throws(() => assertDistinctFixturePorts([['a', "'http://localhost:4201';app.listen({port:4202})"]]), /listener differs/)
 assert.throws(() => assertDistinctFixturePorts([['a', 'serve(t, 0)']]), /invalid fixture/)
})

test('inline DOM browser fixtures do not reserve a server port', () => {
 const inline = "await page.setContent('<div id=app></div>'); await page.addScriptTag({content:script})"
 const ports = assertDistinctFixturePorts([['inline',inline],['server',"'http://localhost:4201';app.listen({port:4201})"]])
 assert.deepEqual([...ports],[ [4201,'server'] ])
})

test('inline DOM setup cannot exempt a server fixture from its port checks', () => {
 const inline = "page.setContent('<div></div>');page.addScriptTag({content:script});"
 for(const server of ['app.listen({host:"localhost",port:4202})','serve(t,chosenPort)','buildLocalApp(config)','page.goto(targetUrl)'])assert.throws(()=>assertDistinctFixturePorts([['server',inline+server]]),/No declared fixture port/)
 assert.throws(()=>assertDistinctFixturePorts([['server',inline+'serve(t,0)']]),/invalid fixture/)
 assert.throws(()=>assertDistinctFixturePorts([['server',inline+"'http://localhost:4201';app.listen({port:4202})"]]),/listener differs/)
 assert.throws(()=>assertDistinctFixturePorts([['inline',inline+"'http://localhost:4201'"],['server','serve(t,4201)']]),/Port 4201 is shared/)
 assert.throws(()=>assertDistinctFixturePorts([['unknown','await browser.newPage()']]),/No declared fixture port/)
})

test('loopback origin variants and allocated ports retain collision checks', () => {
 const fixed = "const port=live?4201:4202,origin='http://127.0.0.1:'+port;app.listen({host:'127.0.0.1',port})"
 const fallback = 'const port=Number(process.env.TEST_PORT??4203),origin=`http://localhost:${port}`;app.listen({port})'
 const ephemeral = 'server.listen(0,"127.0.0.1",done);page.goto(`https://127.0.0.1:${server.address().port}`)'
 assert.deepEqual([...assertDistinctFixturePorts([['fixed',fixed],['fallback',fallback],['ephemeral',ephemeral]])], [[4201,'fixed'],[4202,'fixed'],[4203,'fallback']])
 assert.throws(() => assertDistinctFixturePorts([['fixed',fixed],['other',"'https://localhost:4202'"]]), /Port 4202 is shared/)
 assert.throws(() => assertDistinctFixturePorts([['other',"'http://127.0.0.1:4201';app.listen({host:'127.0.0.1',port:4202})"]]), /listener differs/)
 assert.throws(() => assertDistinctFixturePorts([['invalid',ephemeral.replace('server.address()', 'other.address()')]]), /No declared fixture port/)
})
