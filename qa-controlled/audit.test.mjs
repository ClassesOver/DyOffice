import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile(new URL('./audit.js', import.meta.url), 'utf8')
test('passive audit observes resources/CSP without changing transports or exposing query data', () => {
  const output = { textContent: '' },
    listeners = {},
    fetch = () => {},
    XHR = function () {}
  let callback, options
  const context = {
    URL,
    location: { href: 'http://localhost:18769/qa/controlled?secret=hidden' },
    fetch,
    XMLHttpRequest: XHR,
    document: {
      getElementById: () => output,
      addEventListener: (name, fn) => {
        listeners[name] = fn
      },
    },
    PerformanceObserver: class {
      constructor(fn) {
        callback = fn
      }
      observe(value) {
        options = value
      }
    },
  }
  vm.runInNewContext(source, context)
  assert.deepEqual(JSON.parse(JSON.stringify(options)), { type: 'resource', buffered: true })
  callback({
    getEntries: () => [
      { name: 'http://localhost:18769/api/v1/files/id?token=secret#fragment' },
      { name: 'https://external.test/path?credential=secret' },
    ],
  })
  listeners.securitypolicyviolation({
    effectiveDirective: 'connect-src',
    blockedURI: 'https://blocked.test/path?secret=hidden',
  })
  const data = JSON.parse(output.textContent)
  assert.deepEqual(data.resources, [
    'http://localhost:18769/api/v1/files/id',
    'https://external.test/path',
  ])
  assert.deepEqual(data.cspViolations, ['connect-src: https://blocked.test/path'])
  assert.doesNotMatch(output.textContent, /secret|credential|fragment/)
  assert.equal(context.fetch, fetch)
  assert.equal(context.XMLHttpRequest, XHR)
  assert.equal('window' in context, false)
})
test('passive audit bounds accumulation and reports unavailable observer', () => {
  const output = { textContent: '' }
  let callback
  const context = {
    URL,
    location: { href: 'http://localhost:18769/' },
    document: { getElementById: () => output, addEventListener: () => {} },
    PerformanceObserver: class {
      constructor(fn) {
        callback = fn
      }
      observe() {}
    },
  }
  vm.runInNewContext(source, context)
  callback({
    getEntries: () =>
      Array.from({ length: 300 }, (_, i) => ({ name: 'http://localhost:18769/' + i })),
  })
  const data = JSON.parse(output.textContent)
  assert.equal(data.resources.length, 256)
  assert.equal(data.dropped, 44)
  delete context.PerformanceObserver
  vm.runInNewContext(source, { ...context })
  assert.match(output.textContent, /PerformanceObserver unavailable/)
})
