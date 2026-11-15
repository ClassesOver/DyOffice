import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CLASSES, classify, validateRules, renderMarkdown, build } from './host-ipc-classification.mjs'

const classes = Object.fromEntries(CLASSES.map((c) => [c, 'definition of ' + c]))
const rule = (id, match, cls = 'server-api') => ({ id, class: cls, verifyIn: 'T07', match, web: 'web seam text', rationale: 'rationale text' })
const row = (id, extra = {}) => {
  const [app, rest] = id.split('/')
  const [bridge, name] = rest.split('.')
  return { id, app, bridge, name, lifecycle: 'request', ipc: [{ op: 'invoke', channel: 'x:y' }], calls: 1, ...extra }
}

test('first matching rule wins and every rule must be used', () => {
  const spec = { schema: 1, classes, rules: [rule('specific', '\\.save$', 'server-api'), rule('catch-all', '^slides/', 'browser-native'), rule('never', '\\.nothing$')] }
  const { classified, unclassified, unusedRules } = classify([row('slides/slidesApi.save'), row('slides/slidesApi.addSlide'), row('pdf/pdfApi.ocrPage')], spec)
  assert.deepEqual(classified.map((r) => [r.id, r.class, r.rule]), [
    ['slides/slidesApi.save', 'server-api', 'specific'],
    ['slides/slidesApi.addSlide', 'browser-native', 'catch-all'],
  ])
  assert.deepEqual(unclassified, ['pdf/pdfApi.ocrPage'])
  assert.deepEqual(unusedRules, ['never'])
})

test('rejects unknown classes, missing task references, duplicates and bad patterns', () => {
  const problems = validateRules({ schema: 1, classes, rules: [
    rule('a', 'x', 'magic'),
    { ...rule('b', 'x'), verifyIn: 'later' },
    rule('b', 'y'),
    rule('c', '('),
    { ...rule('d', 'z'), web: '' },
  ] })
  assert.ok(problems.some((p) => p.includes('unknown class "magic"')))
  assert.ok(problems.some((p) => p.includes('verifyIn')))
  assert.ok(problems.some((p) => p.includes('duplicate id')))
  assert.ok(problems.some((p) => p.includes('invalid match')))
  assert.ok(problems.some((p) => p.includes('web is required')))
  assert.ok(validateRules({ schema: 1, classes: {}, rules: [rule('a', 'x')] }).some((p) => p.includes('missing class definition')))
})

test('markdown escapes table cells and lists every member', () => {
  const spec = { schema: 1, status: 'proposed', statusNote: 'note', classes, rules: [rule('r', '.', 'unsupported')] }
  const result = classify([row('docs/desktop.a|b')], spec)
  const md = renderMarkdown(result, spec)
  assert.match(md, /\| `desktop\.a\|b` \|/)
  assert.match(md, /invoke `x:y`/)
  assert.match(md, /\| \*\*all\*\* \| 0 \| 0 \| 0 \| 1 \| 0 \| 1 \|/)
})

test('repository inventory is fully classified and the generated document is current', async () => {
  const { problems, markdown, result } = await build()
  assert.deepEqual(problems, [])
  assert.ok(result.classified.length > 400, 'all four editors contribute members')
  const current = await readFile(new URL('../../docs/dyoffice/inventory/host-ipc.md', import.meta.url), 'utf8')
  assert.equal(current, markdown, 'run node tools/dyoffice/host-ipc-classification.mjs --write')
})
