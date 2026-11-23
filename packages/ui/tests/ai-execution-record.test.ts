/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AiExecutionRecord, compactExecutionOutput, withExecutionRecords, type ExecutionTool } from '../src/AiExecutionRecord'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const tool = (summary: string): ExecutionTool => ({ name: 'read_blocks', summary, output: 'Original result' })
const batch: ExecutionTool = { name: 'sources_query', summary: 'sources_query', input: JSON.stringify({ sourceId: 'rj', queries: ['SELECT count(*) AS n FROM sales', 'SELECT amount FROM sales'] }), output: JSON.stringify({ items: [
  { ok: true, result: { artifact: { resultId: 'result-1' }, totalRows: 1, schema: [{ name: 'n' }], preview: [{ n: 42 }], sourceTruncated: true } },
  { ok: false, status: 504, code: 'SOURCE_TIMEOUT' },
] }) }
const render = (tools: ExecutionTool[]) => act(() => root.render(createElement(AiExecutionRecord, { tools, lang: 'zh' })))
const click = (selector: string) => act(() => host.querySelector<HTMLButtonElement>(selector)!.click())

it('collects tools across model turns within a user request, without moving text or mutating messages', () => {
  const messages = [{ role: 'user', text: 'analyze', tools: [] }, { role: 'assistant', text: 'checking', tools: [tool('first')] }, { role: 'assistant', text: 'writing', tools: [tool('second')] }, { role: 'user', text: 'again', tools: [] }, { role: 'assistant', text: 'next', tools: [tool('third')] }]
  const grouped = withExecutionRecords(messages)
  expect(grouped.map(m => m.tools.map(t => t.summary))).toEqual([[], ['first', 'second'], [], [], ['third']])
  expect(grouped.map(m => m.text)).toEqual(messages.map(m => m.text))
  expect(messages[1].tools).toHaveLength(1)
})
it('does not guess boundaries for old assistant-only history', () => {
  const messages = [{ role: 'assistant', tools: [tool('one')] }, { role: 'assistant', tools: [tool('two')] }]
  expect(withExecutionRecords(messages).map(m => m.tools.length)).toEqual([1, 1])
})
it('shows each batch query, a partial failure, SQL and a bounded result preview', () => {
  render([batch]); expect(host.textContent).toContain('2 个步骤'); expect(host.textContent).toContain('部分失败')
  click('.ai-execution-summary')
  expect(host.querySelectorAll('[data-query-status]')).toHaveLength(2)
  expect(host.textContent).toContain('查询超时')
  click('.ai-execution-step-title')
  expect(host.textContent).toContain('SELECT count(*) AS n FROM sales')
  expect(host.textContent).toContain('rj')
  expect(host.textContent).toContain('42')
  expect(host.textContent).toContain('数据源结果已截断')
  expect(host.textContent).not.toContain('已写入文档')
  click('.ai-execution-query-title')
  expect(host.querySelector('.ai-execution-query-title')?.getAttribute('aria-expanded')).toBe('false')
  expect(host.textContent).not.toContain('SELECT count(*) AS n FROM sales')
  click('.ai-execution-query-title')
  expect(host.textContent).toContain('SELECT count(*) AS n FROM sales')
})
it('does not pretend a running batch has individual results and preserves a manual collapse', () => {
  render([{ ...batch, running: true, output: undefined }])
  expect(host.textContent).toContain('正在执行 2 条查询')
  expect(host.querySelector('[data-query-status]')).toBeNull()
  click('.ai-execution-summary')
  render([batch, { ...tool('next'), running: true }])
  expect(host.querySelector('.ai-execution-summary')?.getAttribute('aria-expanded')).toBe('false')
})
it('marks an all-failed batch as failed and an incomplete stored result as unconfirmed', () => {
  render([{ ...batch, output: '{"items":[{"ok":false,"status":504}]}' }])
  expect(host.textContent).toContain('失败')
  render([{ ...batch, output: '{"items":[' }])
  expect(host.textContent).toContain('结果不完整')
})
it('keeps ordinary tool output and custom media rendering available', () => {
  act(() => root.render(createElement(AiExecutionRecord, { tools: [tool('Read document')], lang: 'en', renderOutput: t => createElement('strong', null, t.output) })))
  click('.ai-execution-summary'); click('.ai-execution-step-title')
  expect(host.querySelector('strong')?.textContent).toBe('Original result')
})
it('preserves complete batch status when long output is retained for display and history', () => {
  const output = JSON.stringify({ items: [ { ok: true, result: { totalRows: 1000, sourceTruncated: true, artifact: { resultId: 'r-1' }, preview: [{ big: 'x'.repeat(30000) }] } }, { ok: false, status: 504, code: 'SOURCE_TIMEOUT' } ] })
  const saved = compactExecutionOutput('sources_query', output, 2000)
  expect(saved.length).toBeLessThanOrEqual(16000)
  const result = JSON.parse(saved)
  expect(result.items[0].result.artifact.resultId).toBe('r-1')
  expect(result.items[0].result.totalRows).toBe(1000)
  expect(result.items[1].code).toBe('SOURCE_TIMEOUT')
  expect(compactExecutionOutput('read_blocks', 'abcdef', 3)).toBe('abc')
})
