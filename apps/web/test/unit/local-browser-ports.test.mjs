import test from 'node:test'
import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'

// The browser suite runs separate files concurrently. Origin is fixed before
// constructing CSRF/CSP services, so each fixture owns a distinct local port.
export function assertDistinctFixturePorts(sources) {
 const owners = new Map()
 for (const [name, source] of sources) {
  const origins = [...source.matchAll(/http:\/\/localhost:(\d+)/g)].map(m => Number(m[1]))
  const serves = [...source.matchAll(/\bserve\(t,\s*(\d+)/g)].map(m => Number(m[1]))
  const ports = new Set([...origins, ...serves])
  // 纯内联 DOM 页面没有服务端；含监听、服务构建或导航的 fixture 仍必须声明端口。
  const inlineDom = /\.setContent\s*\(/.test(source) && /\.addScriptTag\s*\(\s*\{\s*content\s*:/.test(source)
  if (!ports.size && inlineDom && !/\.(?:listen|goto)\s*\(|\b(?:serve|buildLocalApp)\s*\(/.test(source)) continue
  assert.ok(ports.size, `No declared fixture port found in ${name}`)
  for (const match of source.matchAll(/\.listen\(\{\s*port:\s*(\d+)/g)) {
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
