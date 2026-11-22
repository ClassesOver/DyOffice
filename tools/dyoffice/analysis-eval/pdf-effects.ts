import type { AgentToolCall } from '@genoffice/agent-core'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { AGENT_TOOLS, executePdfTool, type PdfAiDeps } from '../../../apps/pdf/src/renderer/ai/tools'
import { planEditOps, runEditOps, type Op, type OpContext } from '../../../apps/pdf/src/renderer/edit-ops'
import type { EditSnapshot } from '../../../apps/pdf/src/renderer/edit-state'

export const definitions = AGENT_TOOLS
const PAGES = ['封面 2026 年度报告', '第一章 收入', '附录 草稿']
export const cases = [
  {
    name: 'apply_ops',
    prompt: '这份 PDF 共 3 页。用 apply_ops 把第 2 页顺时针旋转 90 度。',
    input: { ops: [{ op: 'rotatePages', pages: [2], dir: 90 }] },
    expect: (s: EditSnapshot) => s.rotations.size === 1 && s.rotations.get(1) === 90 && s.deleted.size === 0,
  },
  {
    name: 'apply_ops',
    prompt: '这份 PDF 共 3 页，第 3 页是附录草稿。用 apply_ops 删除第 3 页。',
    input: { ops: [{ op: 'deletePage', page: 3 }] },
    expect: (s: EditSnapshot) => s.deleted.size === 1 && s.deleted.has(2) && s.rotations.size === 0,
  },
  {
    name: 'apply_ops',
    prompt: '用 apply_ops 把文档属性的标题设为“2026 年度报告”，作者设为“财务部”。',
    input: { ops: [{ op: 'setMetadata', metadata: { title: '2026 年度报告', author: '财务部' } }] },
    expect: (s: EditSnapshot) => s.metadata?.title === '2026 年度报告' && s.metadata?.author === '财务部',
  },
]

const empty = (): EditSnapshot => ({
  markups: [], annotDeletes: [], noteEdits: [], drawings: [], textEdits: [], textInserts: [], imageEdits: [],
  stampCfg: null, formEdits: new Map(), formFields: [], formWidgetEdits: new Map(), blankPages: [],
  rotations: new Map(), deleted: new Set(), order: null, metadata: null,
})
/** Page text for the tools that read it; no annotations or form widgets. */
const doc = {
  numPages: PAGES.length,
  getPage: async (n: number) => ({
    getTextContent: async () => ({ items: [{ str: PAGES[n - 1], hasEOL: true }] }),
    getAnnotations: async () => [], cleanup() {},
  }),
} as unknown as PDFDocumentProxy

export async function check(call: AgentToolCall, index: number) {
  const scenario = cases[index]
  if (!scenario || scenario.name !== call.name) throw Error('Unknown evaluation tool')
  // The same pending-edit reducer the PDF editor uses: ops are planned, then
  // folded into the snapshot that save writes to the file.
  let state = empty(), ids = 0
  const newId = () => 'id' + ++ids
  const context = (): OpContext => ({ readOnly: false, pageCount: PAGES.length, deleted: state.deleted, claimedImages: new Set() })
  const used: Partial<PdfAiDeps> = {
    doc: () => doc, fileName: () => 'report.pdf', pageCount: () => PAGES.length, currentPage: () => 1, readOnly: () => false,
    isDeleted: page => state.deleted.has(page), pageOrder: () => state.order ?? PAGES.map((_, page) => page).filter(page => !state.deleted.has(page)),
    metadata: () => ({ title: '', author: '', subject: '', keywords: '', ...(state.metadata ?? {}) }),
    pageGeom: () => ({ pw: 595, ph: 842, rot: 0 }), gotoPage: () => true, outline: () => null, formEdits: () => state.formEdits,
    applyOps: (ops: Op[], opts?: { dryRun?: boolean }) => {
      if (opts?.dryRun) return planEditOps(ops, context(), newId)
      const result = runEditOps(state, ops, context(), newId)
      state = result.state
      return result.plan
    },
  }
  // Anything else the executor reaches for is outside this evaluation.
  const deps = new Proxy(used, { get(target, key) {
    if (key in target) return target[key as keyof PdfAiDeps]
    return () => { throw Error('Not part of this evaluation: ' + String(key)) }
  } }) as PdfAiDeps
  const result = await executePdfTool(deps, call)
  const matches = scenario.expect(state)
  return { passed: !result.isError && result.mutated === true && matches, output: result.output,
    ...(!matches && { state: { rotations: [...state.rotations], deleted: [...state.deleted], metadata: state.metadata } }) }
}
