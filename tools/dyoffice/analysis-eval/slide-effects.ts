import type { AgentToolCall } from '@genoffice/agent-core'
import { createBlankPptx, elementCNvPrId, openPptx, type OpenedPptx } from '@genoffice/pptx-engine'
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render'
import { runTxn } from '../../../packages/pptx-ops/src/ops/index'
import { SLIDES_TOOLS, createSlidesSkill, type DeckAccess } from '../../../apps/slides/src/renderer/ai/slides-skill'

export const definitions = SLIDES_TOOLS
const TITLE = '季度复盘'
const EMU = 12700
export const cases = [
  {
    name: 'apply_ops',
    prompt: '第 1 页（slide 0）上 id 为 e_2 的文本框写着“季度复盘”。用 apply_ops 把它的文字改为“2026 年第四季度复盘”。',
    input: { ops: [{ op: 'setText', target: { slide: 0, el: 'e_2' }, paragraphs: [{ runs: [{ text: '2026 年第四季度复盘' }] }] }] },
    expect: (texts: string[]) => JSON.stringify(texts) === JSON.stringify(['2026 年第四季度复盘', ...SEED.slice(1)]),
  },
  {
    name: 'apply_ops',
    prompt: '第 1 页（slide 0）已有标题和两条要点。用 apply_ops 在 (72pt, 380pt) 处添加一个 400pt × 60pt 的文本框，内容为“下一步：扩大试点”。',
    input: { ops: [{ op: 'addElement', target: { slide: 0 }, kind: 'textbox',
      offset: { x: 72 * EMU, y: 380 * EMU, cx: 400 * EMU, cy: 60 * EMU }, paragraphs: [{ runs: [{ text: '下一步：扩大试点' }] }] }] },
    expect: (texts: string[]) => JSON.stringify(texts) === JSON.stringify([...SEED, '下一步：扩大试点']),
  },
]

/** A page with real content (title and two points), so edits are refinements
 * rather than the from-scratch builds the product sends to generate_deck. */
const SEED = [TITLE, '收入增长 12%', '成本下降 5%']
async function deckWithTitle() {
  const opened = await openPptx(await createBlankPptx())
  const seeded = runTxn(opened, { ops: SEED.map((text, row) => ({ op: 'addElement', target: { slide: 0 }, kind: 'textbox',
    offset: { x: 72 * EMU, y: (72 + row * 100) * EMU, cx: 600 * EMU, cy: 60 * EMU }, paragraphs: [{ runs: [{ text }] }] })) as never })
  if (!seeded.applied) throw Error('Could not prepare the evaluation deck')
  return opened
}
const render = (opened: OpenedPptx): RenderSlide[] =>
  opened.deck.slides.map((slide, index) => buildRenderSlide(slide, opened.deck.size, { fitWidthPx: 1280, slideNo: index + 1 }))
/** Text of every text-bearing element on slide 0, in z-order, read from the slide model (not the render). */
function slideTexts(opened: OpenedPptx): string[] {
  const texts: string[] = []
  for (const element of opened.deck.slides[0]?.elements ?? []) {
    const paragraphs = (element as { text?: { paragraphs?: { runs?: { text?: string }[] }[] } }).text?.paragraphs
    if (!paragraphs) continue
    texts.push(paragraphs.map(paragraph => (paragraph.runs ?? []).map(run => run.text ?? '').join('')).join('\n'))
  }
  return texts
}

export async function check(call: AgentToolCall, index: number) {
  const scenario = cases[index]
  if (!scenario || scenario.name !== call.name) throw Error('Unknown evaluation tool')
  const opened = await deckWithTitle()
  // The prompts name the title box by its cNvPr id, which is stable for this package.
  const ids = opened.deck.slides[0]!.elements.map(element => elementCNvPrId(element))
  if (JSON.stringify(slideTexts(opened)) !== JSON.stringify(SEED) || ids[0] !== 'e_2') throw Error('Unexpected evaluation deck')
  let slides = render(opened)
  // The web host forwards apply_ops to the same transaction executor; here it
  // runs in memory on a real package.
  ;(window as unknown as { slidesApi: unknown }).slidesApi = {
    async applyTxn(req: { ops: unknown[]; isolation?: 'atomic' | 'per_op'; dryRun?: boolean }) {
      const result = runTxn(opened, { ops: req.ops as never, isolation: req.isolation ?? 'atomic', ...(req.dryRun ? { dryRun: true } : {}) })
      if (result.applied && !req.dryRun) slides = render(opened)
      return {
        applied: result.applied, ...(req.dryRun ? { dryRun: true, plan: result.plan ?? [] } : {}),
        ...(result.failures?.length ? { failures: result.failures.map(({ index, error }) => ({ index, error })) } : {}),
        records: (result.records ?? []).map(record => ({ op: record.op.op, target: '0', ...(record.created ? { created: record.created } : {}) })),
        ...(result.applied && !req.dryRun ? { slides } : {}),
      }
    },
  }
  const access = { getSlides: () => slides, getCurrent: () => 0, getSelectedIds: () => [],
    applySlide(i: number, slide: RenderSlide) { slides[i] = slide }, applyDeck(next: RenderSlide[]) { slides = next },
    fitWidthPx: 1280 } as unknown as DeckAccess
  const result = await createSlidesSkill(access).executeTool!(call)
  const texts = slideTexts(opened)
  const matches = scenario.expect(texts)
  return { passed: !result.isError && result.mutated === true && matches, output: result.output, ...(!matches && { texts }) }
}
