import { useState, type ReactNode } from 'react'
import type { Lang } from '@genoffice/i18n'
import { compactDelegatedTranscript, DelegatedAgentResultCard, type DelegatedAgentResult } from './assistant-participants'
import './ai-execution-record.css'

export interface ExecutionTool {
  name?: string | undefined
  summary: string
  input?: string | undefined
  output?: string | undefined
  running?: boolean | undefined
  isError?: boolean | undefined
  delegation?: DelegatedAgentResult | undefined
}

/** View-only grouping. A visible user message is the only reliable request boundary. */
export function withExecutionRecords<T extends { role: string; tools?: readonly ExecutionTool[] }>(messages: readonly T[]): T[] {
  const result = [...messages]
  let inRequest = false, anchor = -1
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') { inRequest = true; anchor = -1; continue }
    if (!inRequest || message.role !== 'assistant' || !message.tools?.length) continue
    if (anchor < 0) { anchor = index; continue }
    const first = result[anchor]
    if (!first) continue
    result[anchor] = { ...first, tools: [...(first.tools ?? []), ...message.tools] }
    result[index] = { ...message, tools: [] }
  }
  return result
}

const sourceOperation = (name = '') => /^sources[._](list|describe|query|save_result|read_result)$/.exec(name)?.[1]
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const parse = (text?: string): Record<string, unknown> => { try { return object(JSON.parse(text ?? '')) } catch { return {} } }

/** Keep source receipts valid JSON without changing the output sent to the model.
 * Ordinary tool outputs keep their existing retention limit. */
export function compactExecutionOutput(name: string, output: string, maxChars: number): string {
  if (!sourceOperation(name)) return compactDelegatedTranscript(name, output, maxChars)
  const limit = 16000
  if (output.length <= limit) return output
  const value = parse(output)
  if (!Object.keys(value).length) return output.slice(0, limit)
  const compact = JSON.stringify({ ...value, executionPreviewTruncated: true }, (key, item: unknown) => {
    if (typeof item === 'string') return item.slice(0, 512)
    if (Array.isArray(item)) return item.slice(0, key === 'items' ? 20 : 3)
    return item
  })
  if (compact.length <= limit) return compact
  // A receipt is more useful than a broken JSON fragment when cells/schema are enormous.
  const receipt = (item: unknown) => {
    const result = object(item), artifact = object(result.artifact)
    return { totalRows: result.totalRows, sourceTruncated: result.sourceTruncated,
      artifact: { resultId: artifact.resultId }, executionPreviewTruncated: true }
  }
  return JSON.stringify(Array.isArray(value.items) && value.items.every(item => typeof object(item).ok === 'boolean')
    ? { items: value.items.map(item => { const row = object(item); return row.ok ? { ok: true, result: receipt(row.result) } : { ok: false, status: row.status, code: row.code } }), executionPreviewTruncated: true }
    : receipt(value))
}

type Status = 'running' | 'done' | 'error' | 'partial' | 'unconfirmed'
function batchItems(tool: ExecutionTool): Record<string, unknown>[] | undefined {
  if (sourceOperation(tool.name) !== 'query' || tool.running) return undefined
  const items = parse(tool.output).items
  return Array.isArray(items) && items.length && items.every(item => typeof object(item).ok === 'boolean') ? items.map(object) : undefined
}
function toolStatus(tool: ExecutionTool): Status {
  if (tool.running) return 'running'
  if (tool.isError) return 'error'
  const items = batchItems(tool)
  if (items) {
    const failures = items.filter(item => !item.ok).length
    return failures === items.length ? 'error' : failures ? 'partial' : 'done'
  }
  if (sourceOperation(tool.name) === 'query' && !parse(tool.output).artifact) return 'unconfirmed'
  return 'done'
}
const queryCount = (tool: ExecutionTool) => batchItems(tool)?.length ?? (Array.isArray(parse(tool.input).queries) ? (parse(tool.input).queries as unknown[]).length : 1)

export function AiExecutionRecord<T extends ExecutionTool>({ tools, lang, renderOutput }: {
  tools: readonly T[]
  lang: Lang
  renderOutput?: (tool: T) => ReactNode
}) {
  const zh = lang.startsWith('zh'), traditional = lang === 'zh-TW'
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map())
  const statuses = tools.map(toolStatus), running = statuses.includes('running')
  const count = tools.reduce((sum, tool) => sum + (sourceOperation(tool.name) === 'query' ? queryCount(tool) : 1), 0)
  const state: Status = running ? 'running' : statuses.every(status => status === 'error') ? 'error'
    : statuses.some(status => status === 'partial' || status === 'error') ? 'partial' : statuses.includes('unconfirmed') ? 'unconfirmed' : 'done'
  const labels: Record<Status, string> = zh
    ? { running: traditional ? '執行中' : '执行中', done: traditional ? '已完成' : '已完成', error: traditional ? '失敗' : '失败', partial: traditional ? '部分失敗' : '部分失败', unconfirmed: traditional ? '結果不完整' : '结果不完整' }
    : { running: 'Running', done: 'Completed', error: 'Failed', partial: 'Partly failed', unconfirmed: 'Incomplete result' }
  const operations: Record<string, string> = zh
    ? { list: '查看数据源', describe: '查看表结构', query: '查询数据', save_result: '保存数据结果', read_result: '读取数据结果' }
    : { list: 'List data sources', describe: 'Inspect table schema', query: 'Query data', save_result: 'Save data result', read_result: 'Read data result' }
  const open = userOpen ?? running
  const toggle = (key: string, fallback = false) => setExpanded(previous => new Map(previous).set(key, !(previous.get(key) ?? fallback)))
  const failure = (item: Record<string, unknown>) => item.code === 'SOURCE_TIMEOUT' || item.status === 504 ? (zh ? '查询超时' : 'Query timed out')
    : item.code === 'SOURCE_SCOPE_DENIED' ? (zh ? '无权访问此数据' : 'Access denied')
    : item.code === 'SQL_POLICY_REJECTED' ? (zh ? '查询被访问策略拒绝' : 'Query rejected by access policy') : (zh ? '查询失败' : 'Query failed')
  const preview = (result: Record<string, unknown>) => {
    const rows = result.preview ?? result.rows
    const visible = Array.isArray(rows) ? rows.slice(0, 5).map(object) : []
    const columns = Object.keys(visible[0] ?? {}).slice(0, 8)
    return <>
      {typeof result.totalRows === 'number' && <p>{zh ? `已取得 ${result.totalRows} 行` : `${result.totalRows} rows retrieved`}</p>}
      {result.sourceTruncated === true && <p className="ai-execution-notice">{zh ? '数据源结果已截断，不能据此推算全量统计。' : 'Source result was truncated; it cannot establish full-data totals.'}</p>}
      {!!columns.length && <div className="ai-execution-table"><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{visible.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{String(row[column] ?? '').slice(0, 300)}</td>)}</tr>)}</tbody></table></div>}
      {(visible.length > 0 || result.executionPreviewTruncated === true) && <p className="ai-execution-muted">{zh ? '仅展示已返回结果的预览，展开不会重新查询。' : 'Preview of the returned result. Expanding does not rerun the query.'}</p>}
    </>
  }
  if (!tools.length) return null
  return <section className="ai-execution-record" data-status={state} aria-label={zh ? '执行记录' : 'Execution record'}>
    <button type="button" className="ai-execution-summary" aria-expanded={open} onClick={() => setUserOpen(!open)}>
      <span className={`ai-execution-status ${state}`} aria-hidden>{running ? '◌' : state === 'done' ? '✓' : '!'}</span>
      <span>{zh ? `${traditional ? '執行記錄' : '执行记录'} · ${count} 个步骤` : `Execution record · ${count} steps`}</span>
      <span className="ai-execution-summary-state">{labels[state]}</span><span aria-hidden>{open ? '⌄' : '›'}</span>
    </button>
    {open && <div className="ai-execution-body">{tools.map((tool, index) => {
      const operation = sourceOperation(tool.name), input = parse(tool.input), result = parse(tool.output), items = batchItems(tool)
      const status = statuses[index]!, title = operation ? operations[operation] : tool.summary
      const key = String(index), detailsOpen = expanded.get(key) ?? false
      const customOutput = !operation && !tool.running ? renderOutput?.(tool) : undefined
      const hasDetails = !!(tool.output || tool.input || customOutput)
      const source = typeof input.sourceId === 'string' ? input.sourceId : undefined
      const sql = typeof input.sql === 'string' ? input.sql : undefined
      const queries = Array.isArray(input.queries) ? input.queries : []
      return <div className="ai-execution-step" key={key} data-status={status}>
        <span className={`ai-execution-status ${status}`} aria-hidden>{status === 'running' ? '◌' : status === 'done' ? '✓' : '!'}</span>
        <div className="ai-execution-content">
          {tool.delegation && <DelegatedAgentResultCard result={tool.delegation} lang={lang}/>}
          <button type="button" className="ai-execution-step-title" title={tool.name} disabled={!hasDetails || tool.running} aria-expanded={detailsOpen} onClick={() => toggle(key)}>{title}{items ? ` · ${items.length}` : ''}<span>{labels[status]}{hasDetails && !tool.running ? detailsOpen ? ' ⌄' : ' ›' : ''}</span></button>
          {tool.running && operation === 'query' && <p className="ai-execution-muted">{zh ? `正在执行 ${queryCount(tool)} 条查询，等待实际结果…` : `Executing ${queryCount(tool)} queries; waiting for results…`}</p>}
          {items ? <div className="ai-execution-queries">{items.map((item, queryIndex) => {
            const itemKey = `${key}:${queryIndex}`, itemOpen = expanded.get(itemKey) ?? detailsOpen
            return <div key={queryIndex} data-query-status={item.ok ? 'done' : 'error'}>
              <button type="button" className="ai-execution-query-title" aria-expanded={itemOpen} onClick={() => toggle(itemKey, detailsOpen)}><span>{zh ? `查询 ${queryIndex + 1}` : `Query ${queryIndex + 1}`}</span><span>{item.ok ? labels.done : failure(item)} {itemOpen ? '⌄' : '›'}</span></button>
              {itemOpen && <div className="ai-execution-detail">{source && <p>{zh ? '数据源' : 'Source'} · {source}</p>}{typeof queries[queryIndex] === 'string' && <pre>{queries[queryIndex] as string}</pre>}{item.ok ? preview(object(item.result)) : <p className="ai-execution-notice">{failure(item)}{typeof item.code === 'string' ? ` · ${item.code}` : ''}</p>}</div>}
            </div>
          })}</div> : null}
          {detailsOpen && !tool.running && <div className="ai-execution-detail">
            {source && !items && <p>{zh ? '数据源' : 'Source'} · {source}</p>}
            {sql && <pre>{sql}</pre>}
            {operation && !items && !tool.isError && preview(result)}
            {operation ? <details><summary>{zh ? '技术详情' : 'Technical details'}</summary><pre>{tool.output}</pre></details> : customOutput ?? <pre>{tool.output}</pre>}
          </div>}
        </div>
      </div>
    })}</div>}
  </section>
}
