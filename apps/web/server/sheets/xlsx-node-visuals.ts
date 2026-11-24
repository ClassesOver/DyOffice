import { XMLParser } from 'fast-xml-parser'
import type { WorkbookVisualObject } from '../../../sheets/src/shared/desktop-api.ts'
import { applyTint } from '../../../sheets/src/renderer/table-styles.ts'
import { relsPathFor, resolveRelTarget } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add.ts'
import { decodeAttribute, parseSheetElements } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets.ts'

type ZipText = (path: string) => Promise<string>
type Chart = NonNullable<WorkbookVisualObject['chart']>
type ChartSeries = Chart['series'][number]
type Axis = NonNullable<Chart['xAxis']>
type Anchor = WorkbookVisualObject['anchor']
type ShapeParagraph = NonNullable<WorkbookVisualObject['paragraphs']>[number]
type XmlToken = Record<string, unknown> & { ':@'?: Record<string, string>; '#text'?: string }
type XmlElement = { tag: string; tokens: XmlToken[]; attrs?: Record<string, string> | undefined }

const xmlParser = new XMLParser({
  preserveOrder: true, removeNSPrefix: true, ignoreAttributes: false,
  processEntities: false, parseTagValue: false, trimValues: false,
  cdataPropName: '#cdata', stopNodes: ['worksheet.sheetData'],
})

function elements(tokens: XmlToken[]): XmlElement[] {
  return tokens.flatMap(token => {
    const tag = Object.keys(token).find(key => !/^[#?:]/.test(key))
    return tag && Array.isArray(token[tag])
      ? [{ tag, tokens: token[tag] as XmlToken[], attrs: token[':@'] }]
      : []
  })
}

function roots(xml: string): XmlElement[] {
  if (!xml) return []
  try { return elements(xmlParser.parse(xml) as XmlToken[]) } catch { return [] }
}

const children = (node?: XmlElement) => node ? elements(node.tokens) : []
const child = (node: XmlElement | undefined, tag: string) => children(node).find(element => element.tag === tag)
function* descendants(node?: XmlElement): Generator<XmlElement> {
  for (const element of children(node)) {
    yield element
    yield* descendants(element)
  }
}
function first(node: XmlElement | undefined, tag: string) {
  for (const descendant of descendants(node)) if (descendant.tag === tag) return descendant
}
function attribute(node: XmlElement | undefined, key: string): string | undefined {
  const raw = node?.attrs?.[`@_${key}`]
  return raw === undefined ? undefined : decodeAttribute(raw)
}
function text(node?: XmlElement): string | undefined {
  if (!node) return undefined
  return node.tokens.map(token => {
    const cdata = token['#cdata'] as XmlToken[] | undefined
    return cdata ? cdata.map(part => part['#text'] ?? '').join('') : decodeAttribute(token['#text'] ?? '')
  }).join('')
}
const val = (node: XmlElement | undefined, name: string) => attribute(child(node, name), 'val')
const finite = (value?: string) => value?.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined
function integer(value?: string): number | undefined {
  const parsed = finite(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
function nonnegative(value?: string): number | undefined {
  const parsed = integer(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}
function flag(node?: XmlElement): boolean | undefined {
  if (!node) return undefined
  return !['0', 'false'].includes(attribute(node, 'val') ?? '')
}
const trueAttribute = (node: XmlElement | undefined, key: string) => ['1', 'true'].includes(attribute(node, key) ?? '')
function member<const T extends readonly string[]>(value: string | undefined, allowed: T): T[number] | undefined {
  return value && allowed.includes(value) ? value : undefined
}

const plotTypes = ['barChart', 'lineChart', 'pieChart', 'doughnutChart', 'areaChart', 'scatterChart', 'radarChart'] as const
const flatPlot = (tag: string) => member(tag.replace(/^(bar|line|pie|area)3DChart$/, '$1Chart'), plotTypes)
const themeSlots = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
const themeAliases: Record<string, string> = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' }

function drawingColor(node: XmlElement | undefined, theme: readonly string[]): string | undefined {
  const direct = attribute(child(node, 'srgbClr'), 'val') ?? attribute(child(node, 'sysClr'), 'lastClr')
  if (direct && /^[\da-f]{6}$/i.test(direct)) return `#${direct.toUpperCase()}`
  const scheme = child(node, 'schemeClr')
  const slot = attribute(scheme, 'val') ?? ''
  const base = theme[themeSlots.indexOf(themeAliases[slot] ?? slot)]
  if (!base || !/^#[\da-f]{6}$/i.test(base)) return undefined
  const tint = finite(val(scheme, 'tint'))
  const shade = finite(val(scheme, 'shade'))
  return tint !== undefined ? applyTint(base, Math.max(0, Math.min(1, 1 - tint / 100_000)))
    : shade !== undefined ? applyTint(base, Math.max(-1, Math.min(0, shade / 100_000 - 1))) : base
}

const color = (scope: XmlElement | undefined, theme: readonly string[]) => drawingColor(child(scope, 'solidFill'), theme)

const cacheLimit = 4096
type CachePoints = { values: (string | undefined)[]; sourceIndexes?: number[] }

function cachePoints(scope?: XmlElement): CachePoints {
  const level = first(scope, 'lvl')
  const points = [...descendants(level ?? scope)].filter(node => node.tag === 'pt')
  if (!points.length) return { values: [] }
  const indexed = points.map(point => ({ index: nonnegative(attribute(point, 'idx')), value: text(child(point, 'v')) }))
  const compact = (): CachePoints => {
    const emitted = indexed.slice(0, cacheLimit)
    return { values: emitted.map(point => point.value), sourceIndexes: emitted.map((point, position) => point.index ?? position) }
  }
  let slots = nonnegative(attribute(first(scope, 'ptCount'), 'val')) ?? 0
  for (const { index } of indexed) {
    if (index === undefined) return compact()
    slots = Math.max(slots, index + 1)
  }
  if (slots > cacheLimit) return compact()
  const values: (string | undefined)[] = Array(slots).fill(undefined)
  for (const { index, value } of indexed) values[index!] = value
  return { values }
}

function categoryGroups(category: XmlElement | undefined, points: CachePoints): ChartSeries['categoryGroups'] {
  if (!points.values.length) return undefined
  const cache = child(child(category, 'multiLvlStrRef'), 'multiLvlStrCache')
  const outer = children(cache).filter(node => node.tag === 'lvl')[1]
  const outerPoints = children(outer).filter(node => node.tag === 'pt')
  if (!outerPoints.length || outerPoints.length > cacheLimit) return undefined
  const starts: { index: number; label: string }[] = []
  for (const point of outerPoints) {
    const index = nonnegative(attribute(point, 'idx'))
    const label = text(child(point, 'v'))
    if (index === undefined || !label) return undefined
    starts.push({ index, label })
  }
  starts.sort((a, b) => a.index - b.index)

  // Oversized or idx-less caches use document order for the detail labels.
  // Walk their source positions in idx order, then express each group's
  // members as a contiguous span of emitted positions.
  const ordered = points.sourceIndexes?.map((index, position) => ({ index, position })).sort((a, b) => a.index - b.index)
  const pointCount = nonnegative(val(cache, 'ptCount')) ?? (ordered ? ordered.at(-1)!.index + 1 : points.values.length)
  const groups: NonNullable<ChartSeries['categoryGroups']> = []
  let cursor = 0
  for (const [position, { index, label }] of starts.entries()) {
    const next = starts[position + 1]?.index ?? pointCount
    if (!ordered) {
      const end = Math.min(next, points.values.length)
      if (index < end) groups.push({ label, start: index, end })
      continue
    }
    while (cursor < ordered.length && ordered[cursor]!.index < index) cursor++
    let start = points.values.length
    let end = 0
    const firstMember = cursor
    while (cursor < ordered.length && ordered[cursor]!.index < next) {
      const emitted = ordered[cursor++]!.position
      start = Math.min(start, emitted)
      end = Math.max(end, emitted + 1)
    }
    if (cursor === firstMember) continue
    if (end - start !== cursor - firstMember) return undefined
    groups.push({ label, start, end })
  }
  return groups.length ? groups : undefined
}

const formula = (scope?: XmlElement) => text(first(scope, 'f'))?.trim() || undefined
const format = (scope?: XmlElement) => text(first(scope, 'formatCode'))
const richText = (scope?: XmlElement) => {
  const nodes = [...descendants(child(scope, 'tx'))]
  return nodes.filter(node => node.tag === 't').map(text).join('') || nodes.filter(node => node.tag === 'v').map(text).join('')
}

function labelMode(labels?: XmlElement): Chart['dataLabels'] {
  if (!labels) return undefined
  if (flag(child(labels, 'delete'))) return 'none'
  const category = flag(child(labels, 'showCatName'))
  const value = flag(child(labels, 'showVal'))
  const percent = flag(child(labels, 'showPercent'))
  if (percent) return category ? value ? 'category-value-percent' : 'category-percent' : 'percent'
  return value ? 'value' : 'none'
}

function parseSeries(series: XmlElement, plot: XmlElement, index: number, theme: readonly string[]): ChartSeries {
  const tx = child(series, 'tx')
  const cachedName = text(first(tx, 'v'))
  const category = child(series, 'cat') ?? child(series, 'xVal')
  const value = child(series, 'val') ?? child(series, 'yVal')
  const categoryCache = cachePoints(category)
  const groups = categoryGroups(category, categoryCache)
  const blanks: number[] = []
  const values = cachePoints(value).values.map((point, index) => {
    const number = finite(point)
    if (number === undefined) blanks.push(index)
    return number ?? 0
  })
  const sp = child(series, 'spPr')
  const stroke = child(sp, 'ln')
  const width = nonnegative(attribute(stroke, 'w'))
  const points = children(series).flatMap(node => {
    const index = node.tag === 'dPt' ? nonnegative(val(node, 'idx')) : undefined
    return index === undefined ? [] : [{ index, color: color(child(node, 'spPr'), theme), pct: nonnegative(val(node, 'explosion')) }]
  })
  const pointColors = points.flatMap(({ index, color }) => color === undefined ? [] : [{ index, color }])
  const pointExplosions = points.flatMap(({ index, pct }) => pct === undefined ? [] : [{ index, pct }])
  const labels = child(series, 'dLbls')
  const pointLabels = children(labels).flatMap(node => {
    const index = node.tag === 'dLbl' ? nonnegative(val(node, 'idx')) : undefined
    if (index === undefined) return []
    const layout = child(child(node, 'layout'), 'manualLayout')
    return [{ index, showVal: flag(child(node, 'delete')) ? false : flag(child(node, 'showVal')),
      offsetX: finite(val(layout, 'x')), offsetY: finite(val(layout, 'y')) }]
  })
  return {
    name: cachedName ?? `Series${index + 1}`, nameRef: cachedName === undefined ? formula(tx) : undefined,
    categories: categoryCache.values.map(point => point ?? ''), values,
    ...(groups ? { categoryGroups: groups } : {}),
    ...(blanks.length ? { blanks } : {}),
    numberFormat: format(value), categoryFormat: format(category),
    color: color(sp, theme) ?? theme[4 + (nonnegative(val(series, 'idx')) ?? index) % 6],
    trendline: val(child(series, 'trendline'), 'trendlineType'),
    valuesRef: formula(value), categoriesRef: formula(category),
    ...(pointColors.length ? { pointColors } : {}),
    explosionPct: nonnegative(val(series, 'explosion')),
    ...(pointExplosions.length ? { pointExplosions } : {}),
    lineColor: child(stroke, 'noFill') && !/^(line|area)3DChart$/.test(plot.tag) ? 'none' : color(stroke, theme),
    lineWidth: width === undefined ? undefined : width / 9525,
    smooth: flag(child(series, 'smooth')), marker: val(child(series, 'marker'), 'symbol'),
    plot: flatPlot(plot.tag), dataLabels: labelMode(labels ?? child(plot, 'dLbls')),
    ...(pointLabels.length ? { pointLabels } : {}),
  }
}

function textStyle(node: XmlElement | undefined, theme: readonly string[]): Chart['titleStyle'] {
  const props = first(child(node, 'txPr'), 'defRPr')
  if (!props) return undefined
  const size = finite(attribute(props, 'sz'))
  const bold = attribute(props, 'b')
  return { size: size === undefined ? undefined : size / 100, bold: bold === undefined ? undefined : bold === '1' || bold === 'true', color: color(props, theme) }
}

function axisInfo(node: XmlElement, series: ChartSeries | undefined, isCategory: boolean, theme: readonly string[]): Axis {
  const scaling = child(node, 'scaling')
  const title = child(node, 'title')
  const fmt = child(node, 'numFmt')
  const linked = ['1', 'true'].includes(attribute(fmt, 'sourceLinked') ?? '')
  const fmtCode = (linked ? isCategory ? series?.categoryFormat : series?.numberFormat : undefined) ?? attribute(fmt, 'formatCode')
  const labelStyle = textStyle(node, theme)
  const titleStyle = textStyle(title, theme)
  return {
    title: title ? richText(title) || 'Axis Title' : undefined,
    min: finite(val(scaling, 'min')), max: finite(val(scaling, 'max')), majorUnit: finite(val(node, 'majorUnit')),
    numFmt: fmtCode && fmtCode !== 'General' ? fmtCode : undefined,
    majorGridlines: child(node, 'majorGridlines') !== undefined,
    hidden: flag(child(node, 'delete')) ?? false, reversed: val(scaling, 'orientation') === 'maxMin',
    position: member(val(node, 'axPos'), ['l', 'r', 't', 'b'] as const),
    labelSize: labelStyle?.size && labelStyle.size > 0 ? labelStyle.size : undefined,
    labelColor: labelStyle?.color,
    titleSize: titleStyle?.size && titleStyle.size > 0 ? titleStyle.size : undefined,
    titleColor: titleStyle?.color,
  }
}

function readChart(xml: string, theme: readonly string[]): Chart | undefined {
  const space = roots(xml).find(node => node.tag === 'chartSpace')
  const chart = child(space, 'chart')
  const plotArea = child(chart, 'plotArea')
  const areaChildren = children(plotArea)
  const plots = areaChildren.filter(node => flatPlot(node.tag))
  const chartTypes = plotTypes.filter(type => plots.some(plot => flatPlot(plot.tag) === type))
  const combo = chartTypes.length === 2 && chartTypes.includes('barChart') && chartTypes.includes('lineChart')
  if ((!combo && chartTypes.length !== 1) || areaChildren.some(node => /Chart$/.test(node.tag) && !flatPlot(node.tag))) return undefined
  const series: ChartSeries[] = []
  const firstSeriesByAxis = new Map<string, ChartSeries>()
  let points = 0
  for (const plot of plots) {
    let firstSeries: ChartSeries | undefined
    for (const node of children(plot)) {
      if (node.tag !== 'ser') continue
      const entry = parseSeries(node, plot, series.length, theme)
      points += entry.values.length + entry.categories.length
      if (points > 50_000 || series.length >= 256) return undefined
      firstSeries ??= entry
      series.push(entry)
    }
    if (firstSeries) for (const axis of children(plot).filter(node => node.tag === 'axId')) {
      const id = attribute(axis, 'val')
      if (id && !firstSeriesByAxis.has(id)) firstSeriesByAxis.set(id, firstSeries)
    }
  }
  const axes = areaChildren.filter(node => ['catAx', 'dateAx', 'valAx'].includes(node.tag)).map(node => {
    const position = val(node, 'axPos')
    const isCategory = node.tag !== 'valAx' || (chartTypes.includes('scatterChart') && (position === 'b' || position === 't'))
    return { isCategory, info: axisInfo(node, firstSeriesByAxis.get(val(node, 'axId') ?? '') ?? series[0], isCategory, theme) }
  })
  const xAxis = axes.find(({ info }) => info.position === 'b' || info.position === 't')?.info
  const yAxis = (axes.find(({ info }) => info.position === 'l') ?? axes.find(({ info, isCategory }) => info.position === 'r' && !isCategory))?.info
  const secondaryYAxis = axes.find(({ info, isCategory }) => info !== yAxis && info.position === 'r' && !isCategory)?.info
  const category = axes.find(axis => axis.isCategory)?.info
  const value = (axes.find(axis => !axis.isCategory && axis.info.position === 'l') ?? axes.find(axis => !axis.isCategory))?.info
  const axisTitles = category?.title || value?.title ? { category: category?.title, value: value?.title } : undefined
  const valueAxis = value?.min !== undefined || value?.max !== undefined ? { min: value.min, max: value.max } : undefined
  const title = child(chart, 'title')
  const legend = child(chart, 'legend')
  const legendPositions = { b: 'bottom', t: 'top', l: 'left' } as const
  const legendSide = member(val(legend, 'legendPos'), ['b', 't', 'l'] as const)
  const bar = plots.find(plot => flatPlot(plot.tag) === 'barChart')
  const line = plots.find(plot => flatPlot(plot.tag) === 'lineChart')
  const doughnut = plots.find(plot => plot.tag === 'doughnutChart')
  const scatter = plots.find(plot => plot.tag === 'scatterChart')
  const labels = child(plots[0], 'dLbls')
  const seriesLabels = child(child(plots[0], 'ser'), 'dLbls')
  const activeLabels = labels && (labelMode(labels) !== 'none' || !seriesLabels) ? labels : seriesLabels
  const positions = { ctr: 'center', inEnd: 'inside-end', outEnd: 'outside-end' } as const
  const position = member(val(activeLabels, 'dLblPos'), ['ctr', 'inEnd', 'outEnd'] as const)
  const autoTitle = title && !flag(child(chart, 'autoTitleDeleted'))
  const namedSoleSeries = series.length === 1 && text(first(child(child(plots[0], 'ser'), 'tx'), 'v'))
  const titleText = richText(title) || (autoTitle ? namedSoleSeries || 'Chart Title' : '')
  return {
    chartTypes, series, barDirection: val(bar, 'barDir'),
    title: titleText,
    legend: legend ? legendSide ? legendPositions[legendSide] : 'right' : 'none',
    dataLabels: labelMode(activeLabels), dataLabelPosition: position ? positions[position] : undefined,
    dataLabelFormat: attribute(child(activeLabels, 'numFmt'), 'formatCode'),
    axisTitles, grouping: member(val(bar ?? plots[0], 'grouping'), ['clustered', 'stacked', 'percentStacked', 'standard'] as const),
    gridlines: value?.majorGridlines, valueAxis, categoryAxisFormat: category?.numFmt,
    gapWidthPct: nonnegative(val(bar, 'gapWidth')), holeSizePct: nonnegative(val(doughnut, 'holeSize')),
    xAxis, yAxis, secondaryYAxis, scatterStyle: val(scatter, 'scatterStyle'), lineMarkers: flag(child(line, 'marker')),
    dispBlanksAs: member(val(chart, 'dispBlanksAs'), ['gap', 'zero', 'span'] as const),
    titleStyle: textStyle(title, theme), dataLabelStyle: textStyle(activeLabels, theme),
    chartAreaFill: color(child(space, 'spPr'), theme), plotAreaFill: color(child(plotArea, 'spPr'), theme),
  }
}

function readAnchor(node: XmlElement): Anchor | undefined {
  const from = child(node, 'from')
  const row = from ? nonnegative(text(child(from, 'row'))) : 0
  const column = from ? nonnegative(text(child(from, 'col'))) : 0
  if (row === undefined || column === undefined || row >= 1_048_576 || column >= 16_384) return undefined
  const position = child(node, 'pos')
  const fromRowOffset = integer(from ? text(child(from, 'rowOff')) : attribute(position, 'y')) ?? 0
  const fromColumnOffset = integer(from ? text(child(from, 'colOff')) : attribute(position, 'x')) ?? 0
  const start = { fromRow: row, fromColumn: column, fromRowOffset, fromColumnOffset }
  const to = child(node, 'to')
  if (to && from) {
    const toRow = nonnegative(text(child(to, 'row')))
    const toColumn = nonnegative(text(child(to, 'col')))
    if (toRow === undefined || toColumn === undefined || toRow >= 1_048_576 || toColumn >= 16_384) return undefined
    return { ...start, toRow, toColumn, toRowOffset: integer(text(child(to, 'rowOff'))) ?? 0,
      toColumnOffset: integer(text(child(to, 'colOff'))) ?? 0, explicitTo: true }
  }
  if (!from && !position) return undefined
  const extent = child(node, 'ext')
  const width = nonnegative(attribute(extent, 'cx'))
  const height = nonnegative(attribute(extent, 'cy'))
  if (width === undefined || height === undefined || !Number.isSafeInteger(fromRowOffset + height) ||
      !Number.isSafeInteger(fromColumnOffset + width)) return undefined
  return { ...start, toRow: row, toColumn: column, toRowOffset: fromRowOffset + height, toColumnOffset: fromColumnOffset + width }
}

export function visualMediaType(path: string): string | undefined {
  switch (path.split(';', 1)[0]?.split('.').at(-1)?.toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
  }
}

function pictureCrop(blipFill?: XmlElement): WorkbookVisualObject['crop'] {
  const src = child(blipFill, 'srcRect')
  if (!src) return undefined
  const side = (name: string) => (finite(attribute(src, name)) ?? 0) / 100_000
  const left = side('l'), top = side('t'), right = side('r'), bottom = side('b')
  if ([left, top, right, bottom].some(value => Math.abs(value) > 1) || left + right >= 1 || top + bottom >= 1 ||
      !(left || top || right || bottom)) return undefined
  return { left, top, right, bottom }
}

function readShapeParagraphs(body: XmlElement | undefined, theme: readonly string[]): ShapeParagraph[] {
  return children(body).filter(node => node.tag === 'p').slice(0, 200).map(paragraph => {
    const properties = child(paragraph, 'pPr')
    const margin = finite(attribute(properties, 'marL'))
    const indent = finite(attribute(properties, 'indent'))
    const numberedBullet = child(properties, 'buAutoNum')
    const runs: ShapeParagraph['runs'] = []
    for (const node of children(paragraph)) {
      if (node.tag === 'br') {
        runs.push({ text: '\n', bold: false, italic: false, underline: false })
      } else if (node.tag === 'r' || node.tag === 'fld') {
        const properties = child(node, 'rPr')
        const size = finite(attribute(properties, 'sz'))
        const underline = attribute(properties, 'u')
        runs.push({
          text: text(child(node, 't')) ?? '',
          color: color(properties, theme),
          bold: trueAttribute(properties, 'b'),
          italic: trueAttribute(properties, 'i'),
          underline: underline !== undefined && underline !== 'none',
          size: size === undefined ? undefined : size / 100,
          caps: member(attribute(properties, 'cap'), ['all', 'small'] as const),
        })
      }
    }
    return {
      align: attribute(properties, 'algn'),
      marginLeft: margin === undefined ? undefined : margin / 12_700,
      indent: indent === undefined ? undefined : indent / 12_700,
      bulletScheme: numberedBullet ? attribute(numberedBullet, 'type') ?? 'arabicPeriod' : undefined,
      bulletStartAt: nonnegative(attribute(numberedBullet, 'startAt')),
      bulletChar: numberedBullet ? undefined : attribute(child(properties, 'buChar'), 'char') || undefined,
      runs,
    }
  })
}

type VisualBase = Pick<WorkbookVisualObject, 'id' | 'sheetId' | 'anchor' | 'name' | 'drawingPath' | 'drawingIndex' | 'editAs' | 'altText'>

function readShape(node: XmlElement, base: VisualBase, theme: readonly string[]): WorkbookVisualObject | undefined {
  const properties = child(node, 'spPr')
  const body = child(node, 'txBody')
  const bodyProperties = child(body, 'bodyPr')
  const textBox = trueAttribute(child(child(node, 'nvSpPr'), 'cNvSpPr'), 'txBox')
  const shapeType = attribute(child(properties, 'prstGeom'), 'prst') ??
    (textBox && !child(properties, 'custGeom') ? 'rect' : undefined)
  const paragraphs = readShapeParagraphs(body, theme)
  const plain = paragraphs.length ? paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n') : undefined
  if (!shapeType && !plain) return undefined

  const style = child(node, 'style')
  function styleColor(name: string): string | undefined {
    const reference = child(style, name)
    if (name !== 'fontRef' && ['0', '1000'].includes(attribute(reference, 'idx') ?? '')) return 'none'
    return drawingColor(reference, theme)
  }
  const line = child(properties, 'ln')
  const width = nonnegative(attribute(line, 'w'))
  const xfrm = child(properties, 'xfrm')
  const angle = finite(attribute(xfrm, 'rot'))
  const extent = angle ? child(xfrm, 'ext') : undefined
  const frameWidth = finite(attribute(extent, 'cx'))
  const frameHeight = finite(attribute(extent, 'cy'))
  return {
    ...base,
    kind: 'shape',
    shapeType,
    fillColor: child(properties, 'noFill') ? 'none' : color(properties, theme) ?? styleColor('fillRef') ?? 'none',
    lineColor: child(line, 'noFill') ? 'none' : color(line, theme) ?? styleColor('lnRef') ?? 'none',
    lineWidth: width === undefined ? undefined : width / 12_700,
    lineDash: val(line, 'prstDash'),
    lineCap: attribute(line, 'cap'),
    flipH: trueAttribute(xfrm, 'flipH'),
    flipV: trueAttribute(xfrm, 'flipV'),
    rotation: angle === undefined ? undefined : angle / 60_000,
    frameWidth: frameWidth && frameWidth > 0 ? frameWidth : undefined,
    frameHeight: frameHeight && frameHeight > 0 ? frameHeight : undefined,
    textColor: styleColor('fontRef'),
    textAnchor: attribute(bodyProperties, 'anchor'),
    textVertOverflow: attribute(bodyProperties, 'vertOverflow'),
    textHorzOverflow: attribute(bodyProperties, 'horzOverflow'),
    paragraphs: paragraphs.length ? paragraphs : undefined,
    text: plain,
  }
}

type GroupBox = { x: number; y: number; width: number; height: number }
const groupTransform = (node: XmlElement) => child(child(node, 'grpSpPr'), 'xfrm')
const transformValue = (transform: XmlElement | undefined, part: string, key: string) => integer(attribute(child(transform, part), key))
const supportedGroupTransform = (transform: XmlElement | undefined) =>
  !finite(attribute(transform, 'rot')) && !trueAttribute(transform, 'flipH') && !trueAttribute(transform, 'flipV')
const groupChildTags = new Set(['grpSp', 'sp', 'cxnSp', 'pic', 'graphicFrame'])

function readGroupShapes(group: XmlElement, base: VisualBase, theme: readonly string[]): WorkbookVisualObject[] {
  const shapeVisuals: WorkbookVisualObject[] = []
  const rootTransform = groupTransform(group)
  const width = transformValue(rootTransform, 'ext', 'cx')
  const height = transformValue(rootTransform, 'ext', 'cy')
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return shapeVisuals
  let ordinal = 0
  function expand(node: XmlElement, box: GroupBox, depth: number) {
    const transform = groupTransform(node)
    if (depth > 32 || !supportedGroupTransform(transform)) return
    const originX = transformValue(transform, 'chOff', 'x') ?? 0
    const originY = transformValue(transform, 'chOff', 'y') ?? 0
    const extentX = transformValue(transform, 'chExt', 'cx') ?? 0
    const extentY = transformValue(transform, 'chExt', 'cy') ?? 0
    const scaleX = extentX > 0 ? box.width / extentX : 1
    const scaleY = extentY > 0 ? box.height / extentY : 1
    for (const entry of children(node)) {
      if (!groupChildTags.has(entry.tag)) continue
      const nonvisual = first(entry, 'cNvPr')
      if (trueAttribute(nonvisual, 'hidden')) continue
      const nested = entry.tag === 'grpSp'
      const transform = nested ? groupTransform(entry)
        : entry.tag === 'graphicFrame' ? child(entry, 'xfrm') : child(child(entry, 'spPr'), 'xfrm')
      const x = transformValue(transform, 'off', 'x')
      const y = transformValue(transform, 'off', 'y')
      const width = transformValue(transform, 'ext', 'cx')
      const height = transformValue(transform, 'ext', 'cy')
      if (x === undefined || y === undefined || width === undefined || height === undefined || width < 0 || height < 0) continue
      const childBox = {
        x: box.x + (x - originX) * scaleX,
        y: box.y + (y - originY) * scaleY,
        width: width * scaleX,
        height: height * scaleY,
      }
      if (nested) {
        if (childBox.width > 0 && childBox.height > 0) expand(entry, childBox, depth + 1)
        continue
      }
      const id = `${base.id}-${++ordinal}`
      if (entry.tag !== 'sp' && entry.tag !== 'cxnSp') continue
      const { fromRow, fromColumn, fromRowOffset, fromColumnOffset } = base.anchor
      const anchor = {
        fromRow, fromColumn,
        fromRowOffset: fromRowOffset + Math.round(childBox.y),
        fromColumnOffset: fromColumnOffset + Math.round(childBox.x),
        toRow: fromRow, toColumn: fromColumn,
        toRowOffset: fromRowOffset + Math.round(childBox.y + childBox.height),
        toColumnOffset: fromColumnOffset + Math.round(childBox.x + childBox.width),
      }
      if (![anchor.fromRowOffset, anchor.fromColumnOffset, anchor.toRowOffset, anchor.toColumnOffset].every(Number.isSafeInteger)) continue
      // The save gateway edits physical anchors. A child has no independent anchor.
      const shape = readShape(entry, {
        id, sheetId: base.sheetId, drawingPath: base.drawingPath, anchor,
        name: attribute(nonvisual, 'name'), altText: attribute(nonvisual, 'descr') || undefined,
      }, theme)
      if (shape) shapeVisuals.push(shape)
    }
  }
  expand(group, { x: 0, y: 0, width, height }, 0)
  return shapeVisuals
}

async function readRelationships(read: ZipText, part: string): Promise<Map<string, XmlElement>> {
  const root = roots(await read(relsPathFor(part))).find(node => node.tag === 'Relationships')
  return new Map(children(root).flatMap(node => {
    const id = node.tag === 'Relationship' ? attribute(node, 'Id') : undefined
    return id ? [[id, node]] : []
  }))
}

function internalTarget(rels: Map<string, XmlElement>, part: string, id: string | undefined, kind: string) {
  const rel = id && rels.get(id)
  if (!rel || attribute(rel, 'TargetMode') === 'External' || !attribute(rel, 'Type')?.endsWith(`/${kind}`)) return undefined
  const target = attribute(rel, 'Target')
  if (!target) return undefined
  try { return resolveRelTarget(part, target) } catch { return undefined }
}

const anchorTags = new Set(['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'])

export async function readWorkbookVisuals(
  read: ZipText,
  sheets: readonly { id: string; name: string }[],
  theme: readonly string[] = [],
  hasPart: (path: string) => boolean = () => true,
): Promise<WorkbookVisualObject[]> {
  const workbook = 'xl/workbook.xml'
  const byName = new Map(sheets.map(sheet => [sheet.name, sheet.id]))
  const workbookRels = await readRelationships(read, workbook)
  const result: WorkbookVisualObject[] = []
  let ordinal = 0
  for (const declaration of parseSheetElements(await read(workbook))) {
    const sheetId = byName.get(declaration.name)
    const sheetPath = internalTarget(workbookRels, workbook, declaration.relationshipId, 'worksheet')
    if (!sheetId || !sheetPath) continue
    const sheetXml = await read(sheetPath)
    if (!sheetXml.includes('drawing')) continue
    const worksheet = roots(sheetXml).find(node => node.tag === 'worksheet')
    const sheetRels = await readRelationships(read, sheetPath)
    for (const node of children(worksheet).filter(node => node.tag === 'drawing')) {
      const drawingPath = internalTarget(sheetRels, sheetPath, attribute(node, 'id'), 'drawing')
      if (!drawingPath || !/^xl\/drawings\/[\w./-]+\.xml$/.test(drawingPath)) continue
      const drawing = roots(await read(drawingPath)).find(node => node.tag === 'wsDr')
      const drawingRels = await readRelationships(read, drawingPath)
      const directAnchors = new Set(children(drawing).map(node => node.tokens))
      const anchors = [...descendants(drawing)].filter(node => anchorTags.has(node.tag))
      for (const [drawingIndex, entry] of anchors.entries()) {
        const id = `visual-${++ordinal}`
        if (drawingIndex > 10_000) break
        // Save-side indices count every physical anchor, including unsupported
        // alternate-content branches. Only top-level anchors render here.
        if (!directAnchors.has(entry.tokens)) continue
        const anchor = readAnchor(entry)
        const nonvisual = first(entry, 'cNvPr')
        if (!anchor || trueAttribute(nonvisual, 'hidden')) continue
        const name = attribute(nonvisual, 'name')
        const editAs = entry.tag === 'twoCellAnchor'
          ? member(attribute(entry, 'editAs'), ['twoCell', 'oneCell', 'absolute'] as const) ?? 'twoCell' : undefined
        const altText = attribute(nonvisual, 'descr') || undefined
        const base = { id, sheetId, anchor, name, drawingPath, drawingIndex, editAs, altText }
        const group = child(entry, 'grpSp')
        if (group) {
          for (const shape of readGroupShapes(group, base, theme)) result.push(shape)
          continue
        }
        const chartNode = first(child(entry, 'graphicFrame'), 'chart')
        if (chartNode) {
          const chartPath = internalTarget(drawingRels, drawingPath, attribute(chartNode, 'id'), 'chart')
          if (!chartPath || !/^xl\/charts\/.+\.xml$/.test(chartPath) || !hasPart(chartPath)) continue
          const chart = readChart(await read(chartPath), theme)
          if (chart) result.push({ ...base, kind: 'chart', chartPath, chart })
          continue
        }
        const shapeNode = child(entry, 'sp') ?? child(entry, 'cxnSp')
        if (shapeNode) {
          const shape = readShape(shapeNode, base, theme)
          if (shape) result.push(shape)
          continue
        }
        const picture = child(entry, 'pic')
        const blipFill = child(picture, 'blipFill')
        const blip = child(blipFill, 'blip')
        const mediaPath = internalTarget(drawingRels, drawingPath, attribute(blip, 'embed'), 'image')
        if (!mediaPath?.startsWith('xl/media/') || !hasPart(mediaPath)) continue
        const mediaType = visualMediaType(mediaPath)
        if (!mediaType || (anchor.fromRow === anchor.toRow && anchor.fromColumn === anchor.toColumn &&
          anchor.fromRowOffset === anchor.toRowOffset && anchor.fromColumnOffset === anchor.toColumnOffset)) continue
        const alpha = finite(attribute(child(blip, 'alphaModFix'), 'amt'))
        const xfrm = child(child(picture, 'spPr'), 'xfrm')
        const rotation = finite(attribute(xfrm, 'rot'))
        const frame = rotation ? child(xfrm, 'ext') : undefined
        const frameWidth = finite(attribute(frame, 'cx'))
        const frameHeight = finite(attribute(frame, 'cy'))
        result.push({ ...base, kind: 'image', mediaPath, mediaType,
          opacity: alpha === undefined || alpha >= 100_000 ? undefined : Math.max(0, alpha / 100_000),
          crop: pictureCrop(blipFill), rotation: rotation ? rotation / 60_000 : undefined,
          flipH: ['1', 'true'].includes(attribute(xfrm, 'flipH') ?? ''), flipV: ['1', 'true'].includes(attribute(xfrm, 'flipV') ?? ''),
          frameWidth: frameWidth && frameWidth > 0 ? frameWidth : undefined,
          frameHeight: frameHeight && frameHeight > 0 ? frameHeight : undefined,
        })
      }
    }
  }
  return result
}
