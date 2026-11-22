import type { AgentToolCall } from '@genoffice/agent-core'
import { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import { proposeOperations, type PlanContext } from '../../../apps/sheets/src/renderer/plan-operations'
import { WORKBOOK_TOOLS, executeWorkbookTool, type SheetsSkillDeps } from '../../../apps/sheets/src/renderer/ai/tools'

export const definitions = WORKBOOK_TOOLS
const sheet = 'sheet-1'
const context = '工作表 Sheet1 的 sheetId 是 sheet-1，A1 是“收入”，A2 是 120。'
export const cases = [
  {
    name: 'propose_operations',
    prompt: context + '在 B1 写入“税额”，在 B2 写入公式 =A2*0.1。',
    input: { summary: '添加税额列', operations: [
      { op: 'set_cell', sheetId: sheet, address: 'B1', value: '税额' },
      { op: 'set_formula', sheetId: sheet, address: 'B2', formula: '=A2*0.1' },
    ] },
    expect: (cells: Cells) => cells.B1?.value === '税额' && cells.B2?.formula === '=A2*0.1' && cells.A2?.value === 120,
  },
  {
    name: 'propose_operations',
    prompt: context + '把 A1:A2 设为加粗并填充黄色背景 #FFFF00。',
    input: { summary: '突出收入', operations: [
      { op: 'format_range', sheetId: sheet, range: 'A1:A2', format: { bold: true, fillColor: '#FFFF00' } },
    ] },
    expect: (_cells: Cells, styles: Styles) => ['A1', 'A2'].every(address =>
      styles[address]?.bold === true && String(styles[address]?.fillColor ?? '').toUpperCase() === '#FFFF00'),
  },
]
type Cells = Record<string, { value: unknown; formula?: string }>
type Styles = Record<string, { bold?: boolean; fillColor?: string }>

export async function check(call: AgentToolCall, index: number) {
  const scenario = cases[index]
  if (!scenario || scenario.name !== call.name) throw Error('Unknown evaluation tool')
  const adapter = new InMemoryWorkbookAdapter({ revision: 0, sheets: [
    { id: sheet, name: 'Sheet1', cells: { A1: { value: '收入' }, A2: { value: 120 } } },
  ] })
  const current = () => adapter.getSnapshot().sheets.find(item => item.id === sheet)!
  const planContext: PlanContext = {
    adapterRef: { current: adapter }, univerRef: { current: null }, lazyWorkbookRef: { current: null },
    lazyPreviewRef: { current: null }, setPreview() {},
    async autoApplySafePlan(plan) { adapter.apply(plan); return { ok: true } as never },
  }
  const unavailable = () => { throw Error('Not part of this evaluation') }
  const deps: SheetsSkillDeps = {
    getActiveSheetInfo: () => ({ mode: 'demo', sheetId: sheet, sheetName: 'Sheet1', revision: adapter.getSnapshot().revision,
      knownAddresses: Object.keys(current().cells), sheets: [{ id: sheet, name: 'Sheet1' }] }) as never,
    readCells: addresses => Object.fromEntries(addresses.map(address => [address, current().cells[address] ?? { value: null }])) as never,
    readFormats: addresses => Object.fromEntries(addresses.flatMap(address => current().styles?.[address] ? [[address, current().styles![address]]] : [])) as never,
    readSheetFeatures: () => '', findCells: unavailable, selectRange: unavailable,
    tracePrecedents: unavailable, traceDependents: unavailable,
    proposeOperations: (operations, summary) => proposeOperations(planContext, operations, summary),
  }
  const result = await executeWorkbookTool(call, deps)
  const after = current()
  const matches = scenario.expect(after.cells as Cells, (after.styles ?? {}) as Styles)
  return { passed: !result.isError && result.mutated === true && matches, output: result.output,
    ...(!matches && { workbook: { cells: after.cells, styles: after.styles } }) }
}
