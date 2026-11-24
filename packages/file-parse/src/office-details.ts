import type { Block, Run } from '@genoffice/docx-engine'
import type { SlideElement, TextElement } from '@genoffice/pptx-engine'

const EMU_PER_INCH = 914400
// Rich Office models use substantially more memory than the plain-text scan on large files.
const MAX_DETAIL_MODEL_BYTES = 5 * 1024 * 1024

function quote(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > 72 ? `${compact.slice(0, 69)}…` : compact
}

function docxRunDetails(runs: Run[]): string[] {
  const details = new Set<string>()
  for (const run of runs) {
    if (!run.text.trim()) continue
    if (run.bold) details.add('加粗')
    if (run.italic) details.add('斜体')
    if (run.underline) details.add('下划线')
    if (run.strike) details.add('删除线')
    if (run.color && run.color !== 'auto') details.add(`文字颜色 #${run.color.replace(/^#/u, '')}`)
    if (run.highlight) details.add(`高亮 ${run.highlight}`)
    if (run.sizeHalfPoints) details.add(`${run.sizeHalfPoints / 2} pt`)
    if (run.font) details.add(`字体 ${run.font}`)
  }
  return [...details]
}

export async function docxFormatDetails(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_DETAIL_MODEL_BYTES) return ''
  const { parseDocx } = await import('@genoffice/docx-engine')
  const parsed = await parseDocx(bytes)
  const lines: string[] = []
  for (const block of parsed.blocks as Block[]) {
    if (block.table) {
      const rows = block.table.rows
      const cells = rows.flat()
      const details = new Set<string>([
        `${rows.length} 行 × ${Math.max(0, ...rows.map((row) => row.length))} 列`,
      ])
      if (block.table.widthPct) details.add(`表格宽度 ${block.table.widthPct}%`)
      if (block.table.fill) details.add(`表格底色 #${block.table.fill.replace(/^#/u, '')}`)
      if (block.table.align && block.table.align !== 'left')
        details.add(`表格${block.table.align === 'center' ? '居中' : '右对齐'}`)
      const borders = [
        ...Object.values(block.table.borders ?? {}),
        ...cells.flatMap((cell) => Object.values(cell.borders ?? {})),
      ]
      if (borders.length) {
        const styles = [
          ...new Set(
            borders
              .map((border) => border.style)
              .filter((style) => style !== 'nil' && style !== 'none'),
          ),
        ]
        const colors = [
          ...new Set(
            borders.flatMap((border) =>
              border.color && border.color !== 'auto'
                ? [`#${border.color.replace(/^#/u, '')}`]
                : [],
            ),
          ),
        ]
        details.add(
          `表格边框${styles.length ? ` ${styles.join('/')}` : ''}${colors.length ? ` ${colors.join(', ')}` : ''}`,
        )
      }
      if (cells.some((cell) => cell.fill))
        details.add(
          `单元格底色 ${[...new Set(cells.flatMap((cell) => (cell.fill ? [`#${cell.fill.replace(/^#/u, '')}`] : [])))].join(', ')}`,
        )
      if (cells.some((cell) => cell.bold || cell.styleBold)) details.add('含粗体单元格')
      if (cells.some((cell) => cell.align && cell.align !== 'left')) details.add('含对齐方式设置')
      lines.push(`- 表格：${[...details].join('；')}`)
    }
    const text = (block.runs ?? [])
      .map((run) => run.text)
      .join('')
      .trim()
    const details = docxRunDetails(block.runs ?? [])
    const align = block.format?.align
    if (align && align !== 'left')
      details.unshift(
        (
          {
            center: '居中',
            right: '右对齐',
            justify: '两端对齐',
            distribute: '分散对齐',
          } as Record<string, string>
        )[align] ?? align,
      )
    if (text && details.length)
      lines.push(`- “${quote(text)}”：${[...new Set(details)].join('；')}`)
    if (lines.length >= 160) break
  }
  return lines.length ? `## Word 样式细节\n${lines.join('\n')}` : ''
}

function runDetails(element: TextElement): string[] {
  const details = new Set<string>()
  for (const paragraph of element.text?.paragraphs ?? []) {
    for (const run of paragraph.runs) {
      if (!run.text.trim()) continue
      if (run.bold) details.add('加粗')
      if (run.italic) details.add('斜体')
      if (run.underline) details.add('下划线')
      if (run.fontSize) details.add(`${run.fontSize} pt`)
      if (run.fontFamily) details.add(`字体 ${run.fontFamily}`)
      if (run.color && run.color !== 'none') details.add(run.color)
      if (run.highlight && run.highlight !== 'none') details.add(`高亮 ${run.highlight}`)
    }
  }
  return [...details]
}

function elementText(element: SlideElement): string {
  if (element.type === 'picture') return '[图片]'
  if (element.type === 'chart') return '[图表]'
  if (element.type === 'table') return '[表格]'
  if (element.type === 'group') return '[组合图形]'
  if (element.type === 'passthrough') return '[其他对象]'
  return (
    element.text?.paragraphs
      .flatMap((paragraph) => paragraph.runs.map((run) => run.text))
      .join(' ')
      .trim() || `[${element.presetGeometry ?? '文本框'}]`
  )
}

function fillDetails(element: SlideElement): string[] {
  if (!('fill' in element) || !element.fill) return []
  const fill = element.fill
  if (fill.type === 'solid') return [`填充 ${fill.color}`]
  if (fill.type === 'gradient')
    return [`渐变填充 ${fill.stops.map((stop) => stop.color).join('→')}`]
  if (fill.type === 'image') return ['图片填充']
  return []
}

interface ElementPosition {
  element: SlideElement
  x: number
  y: number
  cx: number
  cy: number
  parentGroups: string[]
}

function positionedElements(
  elements: SlideElement[],
  parent: {
    x: number
    y: number
    scaleX: number
    scaleY: number
    offsetX: number
    offsetY: number
  } = {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
  },
  parentGroups: string[] = [],
): ElementPosition[] {
  const result: ElementPosition[] = []
  for (const element of elements) {
    const frame = element.transform.offset
    const x = parent.x + (frame.x - parent.offsetX) * parent.scaleX
    const y = parent.y + (frame.y - parent.offsetY) * parent.scaleY
    result.push({
      element,
      x,
      y,
      cx: frame.cx * parent.scaleX,
      cy: frame.cy * parent.scaleY,
      parentGroups,
    })
    if (element.type !== 'group') continue
    const childOffset = element.childOffset ?? { x: 0, y: 0, cx: frame.cx, cy: frame.cy }
    const groupName = element.name ? `「${element.name}」` : '未命名组合图形'
    result.push(
      ...positionedElements(
        element.children,
        {
          x,
          y,
          scaleX: childOffset.cx ? (frame.cx * parent.scaleX) / childOffset.cx : parent.scaleX,
          scaleY: childOffset.cy ? (frame.cy * parent.scaleY) / childOffset.cy : parent.scaleY,
          offsetX: childOffset.x,
          offsetY: childOffset.y,
        },
        [...parentGroups, groupName],
      ),
    )
  }
  return result
}

export async function pptxFormatDetails(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_DETAIL_MODEL_BYTES) return ''
  const { openPptx } = await import('@genoffice/pptx-engine')
  const { deck } = await openPptx(bytes)
  const lines: string[] = []
  for (const [slideIndex, slide] of deck.slides.entries()) {
    for (const position of positionedElements(slide.elements)) {
      const { element, x, y, cx, cy, parentGroups } = position
      const placement = `左 ${+(x / EMU_PER_INCH).toFixed(1)} in，上 ${+(y / EMU_PER_INCH).toFixed(1)} in，宽 ${+(cx / EMU_PER_INCH).toFixed(1)} in，高 ${+(cy / EMU_PER_INCH).toFixed(1)} in`
      const details = element.type === 'text' || element.type === 'shape' ? runDetails(element) : []
      if (element.type === 'text' || element.type === 'shape') {
        const alignments = [
          ...new Set(
            (element.text?.paragraphs ?? []).flatMap((paragraph) =>
              paragraph.align ? [paragraph.align] : [],
            ),
          ),
        ]
        details.push(
          ...alignments.map(
            (align) =>
              `段落${({ center: '居中', right: '右对齐', justify: '两端对齐', left: '左对齐' } as Record<string, string>)[align] ?? align}`,
          ),
        )
      }
      details.push(...fillDetails(element))
      if ('stroke' in element && element.stroke?.fill.type === 'solid') {
        details.push(`边框 ${element.stroke.fill.color}`)
      }
      const name = 'name' in element && element.name ? `「${element.name}」` : ''
      const shape =
        element.type === 'shape' && element.presetGeometry ? `，${element.presetGeometry}` : ''
      const styling = details.length ? `；${details.join('；')}` : ''
      const groupPath = parentGroups.length ? `组合图形 ${parentGroups.join(' / ')} 内 ` : ''
      lines.push(
        `- 第 ${slideIndex + 1} 页 ${groupPath}${name}${shape}“${quote(elementText(element))}”：${placement}${styling}`,
      )
      if (lines.length >= 240) break
    }
    if (lines.length >= 240) break
  }
  return lines.length ? `## PowerPoint 版式与样式细节\n${lines.join('\n')}` : ''
}
