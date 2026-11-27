import { XMLParser } from 'fast-xml-parser'
import { WORKBOOK_CHART_PATH } from '../../../../packages/xlsx-gateway/src/shared/workbook-chart-path.ts'
import type { WorkbookPagePrintSettings, WorkbookVisualObject } from '../../../sheets/src/shared/desktop-api.ts'
import { applyTint } from '../../../sheets/src/renderer/table-styles.ts'
import {
  drawingAnchorElements, drawingChild, drawingMainChild, drawingNonVisualProperties, drawingRelationshipAttribute, isDrawingMainName, pictureExtensionBlips, readDrawingGraphicFrame, readDrawingPicture, SVG_BLIP_NAMESPACE,
} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-anchors.ts'
import { isOfficeRelationshipNamespace } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-namespace.ts'
import { elementText, scopedChildren, spreadsheetSheetRoot, withBody, type Attributes, type ScopedElement } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-worksheet-xml.ts'
import { relsPathFor, resolveRelTarget } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add.ts'
import { decodeAttribute, parseRelationships, parseSheetElements, type ParsedRelationship } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets.ts'
import { resolveWorkbookSheetTarget } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-workbook-parts.ts'

type ZipText = (path: string) => Promise<string>
type Chart = NonNullable<WorkbookVisualObject['chart']>
type ChartSeries = Chart['series'][number]
type Axis = NonNullable<Chart['xAxis']>
type SourceNumberFormat = (reference: string) => string | undefined
type LinkedFormats = { value: string | undefined; category: string | undefined }
type Anchor = WorkbookVisualObject['anchor']
type ShapeParagraph = NonNullable<WorkbookVisualObject['paragraphs']>[number]
type XmlToken = Record<string, unknown> & { ':@'?: Record<string, string>; '#text'?: string }
type XmlElement = {
  name: string
  tag: string
  namespace: string | undefined
  drawingMainOnly?: boolean
  tokens: XmlToken[]
  namespaces: Attributes
  attrs?: Record<string, string> | undefined
}
type Relationships = ReadonlyMap<string, ParsedRelationship>

const xmlParser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false,
  processEntities: false, parseTagValue: false, trimValues: false,
  cdataPropName: '#cdata',
})

function elements(tokens: XmlToken[], inherited: Attributes): XmlElement[] {
  return tokens.flatMap(token => {
    const name = Object.keys(token).find(key => !/^[#?:]/.test(key))
    if (!name || !Array.isArray(token[name])) return []
    const attrs = token[':@']
    let bindings: Map<string, string> | undefined
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (key !== '@_xmlns' && !key.startsWith('@_xmlns:')) continue
      bindings ??= new Map(inherited)
      bindings.set(key.slice('@_xmlns:'.length), decodeAttribute(value))
    }
    const namespaces = bindings ?? inherited
    const colon = name.indexOf(':')
    const namespace = colon < 0 ? namespaces.get('') ?? '' : namespaces.get(name.slice(0, colon))
    return [{ name, tag: name.slice(colon + 1), namespace, tokens: token[name] as XmlToken[], attrs, namespaces }]
  })
}

function roots(xml: string, namespaces: Attributes = new Map()): XmlElement[] {
  if (!xml) return []
  try { return elements(xmlParser.parse(xml) as XmlToken[], namespaces) } catch { return [] }
}

function worksheetVisualRoot(xml: string): XmlElement | undefined {
  const root = spreadsheetSheetRoot(xml)
  if (!root) return undefined
  const visualNodes = scopedChildren(root).filter(node => node.namespace === root.namespace &&
    ['drawing', 'legacyDrawing', 'legacyDrawingHF', 'oleObjects'].includes(node.local))
  return roots(withBody(root, visualNodes.map(node => node.xml).join('')), root.namespaces)[0]
}

function children(node?: XmlElement): XmlElement[] {
  if (!node) return []
  const entries = elements(node.tokens, node.namespaces)
  if (!node.drawingMainOnly) return entries
  return entries.filter(entry => isDrawingMainName(entry.name, entry.namespace))
    .map(entry => ({ ...entry, drawingMainOnly: true }))
}
function sheetDrawingChild(node: XmlElement, tag: string): XmlElement | undefined {
  return children(node).find(entry => entry.tag === tag && entry.namespace === node.namespace &&
    (entry.namespace !== undefined || entry.name.startsWith('xdr:')))
}
function drawingMainPart(node: XmlElement, tag: string): XmlElement | undefined {
  const part = sheetDrawingChild(node, tag)
  return part && { ...part, drawingMainOnly: true }
}
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
  const raw = node?.attrs?.[`@_${key}`] ?? Object.entries(node?.attrs ?? {}).find(([name]) =>
    !name.startsWith('@_xmlns:') && name.endsWith(`:${key}`)
  )?.[1]
  return raw === undefined ? undefined : decodeAttribute(raw)
}
function relationshipAttribute(node: XmlElement | undefined, key: string): string | undefined {
  if (!node?.attrs) return undefined
  let found: string | undefined
  let unbound: string | undefined
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name.startsWith('@_xmlns:') || !name.endsWith(`:${key}`)) continue
    const prefix = name.slice(2, -(key.length + 1))
    const namespace = node.namespaces.get(prefix)
    if (isOfficeRelationshipNamespace(namespace)) {
      if (found !== undefined) return undefined
      found = value
    } else if (prefix === 'r' && namespace === undefined) {
      unbound = value
    }
  }
  const raw = found ?? unbound
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

export function mixHexColors(first: string, last: string): string {
  const channels = [1, 3, 5].map(offset => {
    const a = Number.parseInt(first.slice(offset, offset + 2), 16)
    const b = Number.parseInt(last.slice(offset, offset + 2), 16)
    return Math.floor((a + b) / 2).toString(16).padStart(2, '0')
  })
  return `#${channels.join('').toUpperCase()}`
}

function color(scope: XmlElement | undefined, theme: readonly string[]): string | undefined {
  const solid = child(scope, 'solidFill')
  if (solid) return drawingColor(solid, theme)
  const gradient = child(scope, 'gradFill')
  const stops = children(child(gradient, 'gsLst')).flatMap(stop => {
    if (stop.tag !== 'gs') return []
    const position = finite(attribute(stop, 'pos'))
    const rgb = drawingColor(stop, theme)
    return position !== undefined && rgb ? [{ position, rgb }] : []
  }).sort((a, b) => a.position - b.position)
  const first = stops[0], last = stops.at(-1)
  return first && last ? mixHexColors(first.rgb, last.rgb) : undefined
}

function areaColor(scope: XmlElement | undefined, theme: readonly string[]): string | undefined {
  if (child(scope, 'noFill')) return undefined
  const pattern = child(scope, 'pattFill')
  if (!pattern) return color(scope, theme)
  const foreground = drawingColor(child(pattern, 'fgClr'), theme)
  const background = drawingColor(child(pattern, 'bgClr'), theme)
  return foreground && background ? mixHexColors(foreground, background) : foreground ?? background
}

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

function parseSeries(series: XmlElement, plot: XmlElement, index: number, theme: readonly string[], lookup: SourceNumberFormat) {
  const tx = child(series, 'tx')
  const cachedName = text(first(tx, 'v'))
  const category = child(series, 'cat') ?? child(series, 'xVal')
  const value = child(series, 'val') ?? child(series, 'yVal')
  const categoriesRef = formula(category), valuesRef = formula(value)
  const categorySource = categoriesRef && first(category, 'numRef') ? lookup(categoriesRef) : undefined
  const valueSource = valuesRef ? lookup(valuesRef) : undefined
  const categoryCacheFormat = format(category), valueCacheFormat = format(value)
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
  const entry: ChartSeries = {
    name: cachedName ?? `Series${index + 1}`, nameRef: cachedName === undefined ? formula(tx) : undefined,
    categories: categoryCache.values.map(point => point ?? ''), values,
    ...(groups ? { categoryGroups: groups } : {}),
    ...(blanks.length ? { blanks } : {}),
    numberFormat: valueCacheFormat ?? valueSource, categoryFormat: categoryCacheFormat ?? categorySource,
    color: color(sp, theme) ?? theme[4 + (nonnegative(val(series, 'idx')) ?? index) % 6],
    trendline: val(child(series, 'trendline'), 'trendlineType'),
    valuesRef, categoriesRef,
    ...(pointColors.length ? { pointColors } : {}),
    explosionPct: nonnegative(val(series, 'explosion')),
    ...(pointExplosions.length ? { pointExplosions } : {}),
    lineColor: child(stroke, 'noFill') && !/^(line|area)3DChart$/.test(plot.tag) ? 'none' : color(stroke, theme),
    lineWidth: width === undefined ? undefined : width / 9525,
    smooth: flag(child(series, 'smooth')), marker: val(child(series, 'marker'), 'symbol'),
    plot: flatPlot(plot.tag), dataLabels: labelMode(labels ?? child(plot, 'dLbls')),
    ...(pointLabels.length ? { pointLabels } : {}),
  }
  // Series describe the stored cache. Linked axes and labels prefer live cell formatting.
  const linked: LinkedFormats = {
    value: valueSource ?? valueCacheFormat, category: categorySource ?? categoryCacheFormat,
  }
  return { entry, linked }
}

function textStyle(node: XmlElement | undefined, theme: readonly string[]): Chart['titleStyle'] {
  const props = first(child(node, 'txPr'), 'defRPr')
  if (!props) return undefined
  const size = finite(attribute(props, 'sz'))
  const bold = attribute(props, 'b')
  return { size: size === undefined ? undefined : size / 100, bold: bold === undefined ? undefined : bold === '1' || bold === 'true', color: color(props, theme) }
}

function resolveNumberFormat(node: XmlElement | undefined, source: string | undefined) {
  const literal = attribute(node, 'formatCode')
  return trueAttribute(node, 'sourceLinked') ? source ?? literal : literal
}

const builtInDisplayUnits = new Map<string, readonly [number, string]>([
  ['hundreds', [1e2, 'Hundreds']], ['thousands', [1e3, 'Thousands']],
  ['tenThousands', [1e4, 'x 10000']], ['hundredThousands', [1e5, 'x 100000']],
  ['millions', [1e6, 'Millions']], ['tenMillions', [1e7, 'x 10000000']],
  ['hundredMillions', [1e8, 'x 100000000']], ['billions', [1e9, 'Billions']],
  ['trillions', [1e12, 'Trillions']],
])

function axisInfo(node: XmlElement, linkedFormat: string | undefined, theme: readonly string[]): Axis {
  const scaling = child(node, 'scaling')
  const title = child(node, 'title')
  const fmtCode = resolveNumberFormat(child(node, 'numFmt'), linkedFormat)
  const units = child(node, 'dispUnits')
  const builtIn = builtInDisplayUnits.get(val(units, 'builtInUnit') ?? '')
  const custom = finite(val(units, 'custUnit'))
  const displayUnit = builtIn?.[0] ?? (custom !== undefined && custom > 0 ? custom : undefined)
  const unitLabel = child(units, 'dispUnitsLbl')
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
    displayUnit,
    displayUnitLabel: displayUnit !== undefined && unitLabel ? richText(unitLabel) || builtIn?.[1] : undefined,
  }
}

function readChart(xml: string, theme: readonly string[], lookup: SourceNumberFormat): Chart | undefined {
  const space = roots(xml).find(node => node.tag === 'chartSpace')
  const chart = child(space, 'chart')
  const plotArea = child(chart, 'plotArea')
  const areaChildren = children(plotArea)
  const plots = areaChildren.filter(node => flatPlot(node.tag))
  const chartTypes = plotTypes.filter(type => plots.some(plot => flatPlot(plot.tag) === type))
  const combo = chartTypes.length === 2 && chartTypes.includes('barChart') && chartTypes.includes('lineChart')
  if ((!combo && chartTypes.length !== 1) || areaChildren.some(node => /Chart$/.test(node.tag) && !flatPlot(node.tag))) return undefined
  const series: ChartSeries[] = []
  let firstLinkedFormats: LinkedFormats | undefined
  const linkedFormatsByAxis = new Map<string, LinkedFormats>()
  let points = 0
  for (const plot of plots) {
    let plotLinkedFormats: LinkedFormats | undefined
    for (const node of children(plot)) {
      if (node.tag !== 'ser') continue
      const { entry, linked } = parseSeries(node, plot, series.length, theme, lookup)
      points += entry.values.length + entry.categories.length
      if (points > 50_000 || series.length >= 256) return undefined
      firstLinkedFormats ??= linked
      plotLinkedFormats ??= linked
      series.push(entry)
    }
    if (plotLinkedFormats) for (const axis of children(plot).filter(node => node.tag === 'axId')) {
      const id = attribute(axis, 'val')
      if (id && !linkedFormatsByAxis.has(id)) linkedFormatsByAxis.set(id, plotLinkedFormats)
    }
  }
  const axes = areaChildren.filter(node => ['catAx', 'dateAx', 'valAx'].includes(node.tag)).map(node => {
    const position = val(node, 'axPos')
    const isCategory = node.tag !== 'valAx' || (chartTypes.includes('scatterChart') && (position === 'b' || position === 't'))
    const linked = linkedFormatsByAxis.get(val(node, 'axId') ?? '') ?? firstLinkedFormats
    return { isCategory, info: axisInfo(node, isCategory ? linked?.category : linked?.value, theme) }
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
    dataLabelFormat: resolveNumberFormat(child(activeLabels, 'numFmt'), firstLinkedFormats?.value),
    axisTitles, grouping: member(val(bar ?? plots[0], 'grouping'), ['clustered', 'stacked', 'percentStacked', 'standard'] as const),
    gridlines: value?.majorGridlines, valueAxis, categoryAxisFormat: category?.numFmt,
    gapWidthPct: nonnegative(val(bar, 'gapWidth')), holeSizePct: nonnegative(val(doughnut, 'holeSize')),
    xAxis, yAxis, secondaryYAxis, scatterStyle: val(scatter, 'scatterStyle'), lineMarkers: flag(child(line, 'marker')),
    dispBlanksAs: member(val(chart, 'dispBlanksAs'), ['gap', 'zero', 'span'] as const),
    titleStyle: textStyle(title, theme), dataLabelStyle: textStyle(activeLabels, theme),
    chartAreaFill: areaColor(child(space, 'spPr'), theme), plotAreaFill: areaColor(child(plotArea, 'spPr'), theme),
  }
}

function readAnchor<Node>(
  node: Node,
  child: (node: Node | undefined, key: string) => Node | undefined,
  text: (node: Node | undefined) => string | undefined,
  attribute: (node: Node | undefined, key: string) => string | undefined,
): Anchor | undefined {
  const from = child(node, 'from')
  const row = from ? nonnegative(text(child(from, 'row'))) : 0
  const column = from ? nonnegative(text(child(from, 'col'))) : 0
  if (row === undefined || column === undefined || row >= 1_048_576 || column >= 16_384) return undefined
  const position = child(node, 'pos')
  const fromRowOffset = integer(from ? text(child(from, 'rowOff')) : attribute(position, 'y')) ?? 0
  const fromColumnOffset = integer(from ? text(child(from, 'colOff')) : attribute(position, 'x')) ?? 0
  const start = { fromRow: row, fromColumn: column, fromRowOffset, fromColumnOffset }
  const to = child(node, 'to')
  if (to !== undefined && from !== undefined) {
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

function readDrawingAnchor(node: ScopedElement): Anchor | undefined {
  const anchor = readAnchor(
    node,
    drawingChild,
    field => field && elementText(field.inner),
    (field, key) => field?.attributes.get(key),
  )
  return anchor && node.local === 'absoluteAnchor' ? { ...anchor, absolute: true } : anchor
}

export function visualMediaType(path: string): string | undefined {
  switch (path.split(';', 1)[0]?.split('.').at(-1)?.toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'svg': return 'image/svg+xml'
    case 'emf': return 'image/x-emf'
    case 'wmf': return 'image/x-wmf'
    case 'emz': return 'image/x-emz'
    case 'wmz': return 'image/x-wmz'
  }
}

function pictureCrop(blipFill?: ScopedElement): WorkbookVisualObject['crop'] {
  const src = drawingMainChild(blipFill, 'srcRect')
  if (!src) return undefined
  const side = (name: string) => (finite(src.attributes.get(name)) ?? 0) / 100_000
  const left = side('l'), top = side('t'), right = side('r'), bottom = side('b')
  if ([left, top, right, bottom].some(value => Math.abs(value) > 1) || left + right >= 1 || top + bottom >= 1 ||
      !(left || top || right || bottom)) return undefined
  return { left, top, right, bottom }
}

function blipOpacity(amount: string | undefined): number | undefined {
  const alpha = finite(amount)
  return alpha === undefined || alpha >= 100_000 ? undefined : Math.max(0, alpha / 100_000)
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

type VisualBase = Pick<WorkbookVisualObject, 'id' | 'sheetId' | 'anchor' | 'name' | 'drawingPath' | 'drawingIndex' | 'editAs' | 'altText' | 'hyperlink'>
type DrawingReferences = {
  relationships: Relationships
  part: string
  hasPart: (path: string) => boolean
}

function drawingHyperlink(id: string | undefined, relationships: Relationships) {
  const rel = id === undefined ? undefined : relationships.get(id)
  return rel?.type.endsWith('/hyperlink') ? rel.target || undefined : undefined
}

const pathCommands = new Map<string, readonly [letter: string, points: number]>([
  ['moveTo', ['M', 1]], ['lnTo', ['L', 1]], ['cubicBezTo', ['C', 3]],
  ['quadBezTo', ['Q', 2]], ['close', ['Z', 0]],
])

function readCustomPath(geometry: XmlElement | undefined): WorkbookVisualObject['customPath'] {
  const paths = children(child(geometry, 'pathLst')).filter(path => path.tag === 'path')
  const segments: string[] = []
  const fillable: string[] = []
  let width = 0, height = 0
  const format = (value: number) => Number.isInteger(value) && Math.abs(value) < 1e15 ? String(value) : value.toFixed(2)
  for (const path of paths) {
    const pathWidth = Math.max(0, finite(attribute(path, 'w')) ?? 0)
    const pathHeight = Math.max(0, finite(attribute(path, 'h')) ?? 0)
    if (!segments.length) {
      width = pathWidth
      height = pathHeight
    }
    const scaleX = width && pathWidth ? width / pathWidth : 1
    const scaleY = height && pathHeight ? height / pathHeight : 1
    const commands: string[] = []
    for (const node of children(path)) {
      const command = pathCommands.get(node.tag)
      if (!command) return undefined
      const [letter, required] = command
      const points = children(node).filter(point => point.tag === 'pt').slice(0, required)
      if (points.length < required) return undefined
      const tokens = [letter]
      for (const point of points) {
        const x = (finite(attribute(point, 'x')) ?? NaN) * scaleX
        const y = (finite(attribute(point, 'y')) ?? NaN) * scaleY
        if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
        tokens.push(format(x), format(y))
      }
      commands.push(tokens.join(' '))
    }
    if (!commands.length) continue
    const segment = commands.join(' ')
    segments.push(segment)
    if (attribute(path, 'fill') !== 'none') fillable.push(segment)
  }
  if (!segments.length) return undefined
  return {
    width: Math.max(1, width), height: Math.max(1, height), d: segments.join(' '),
    ...(!fillable.length ? { strokeOnly: true } : {}),
    ...(fillable.length && fillable.length < segments.length ? { fillD: fillable.join(' ') } : {}),
  }
}

function readShape(
  node: XmlElement, base: VisualBase, theme: readonly string[], references: DrawingReferences,
): WorkbookVisualObject | undefined {
  const properties = drawingMainPart(node, 'spPr')
  const body = child(node, 'txBody')
  const bodyProperties = child(body, 'bodyPr')
  const textBox = trueAttribute(child(child(node, 'nvSpPr'), 'cNvSpPr'), 'txBox')
  const geometry = child(properties, 'custGeom')
  const shapeType = attribute(child(properties, 'prstGeom'), 'prst') ?? (textBox && !geometry ? 'rect' : undefined)
  const customPath = shapeType ? undefined : readCustomPath(geometry)
  const paragraphs = readShapeParagraphs(body, theme)
  const plain = paragraphs.length ? paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n') : undefined
  if (!shapeType && !customPath && !plain) return undefined

  const style = drawingMainPart(node, 'style')
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
  const blip = child(child(properties, 'blipFill'), 'blip')
  const fillMediaPath = previewPath(references.relationships, references.part, relationshipAttribute(blip, 'embed'), references.hasPart) ??
    svgEmbedsPreview(shapeSvgEmbeds(blip), references)
  const fillColor = child(properties, 'noFill') ? 'none'
    : areaColor(properties, theme) ?? (fillMediaPath ? 'none' : styleColor('fillRef') ?? 'none')
  return {
    ...base,
    kind: 'shape',
    shapeType,
    ...(customPath ? { customPath } : {}),
    fillColor,
    ...(fillMediaPath ? { fillMediaPath, fillMediaType: visualMediaType(fillMediaPath), opacity: blipOpacity(attribute(child(blip, 'alphaModFix'), 'amt')) } : {}),
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

function readGroupShapes(
  group: XmlElement, base: VisualBase, theme: readonly string[], references: DrawingReferences,
): WorkbookVisualObject[] {
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
        hyperlink: drawingHyperlink(relationshipAttribute(child(nonvisual, 'hlinkClick'), 'id'), references.relationships),
      }, theme, references)
      if (shape) shapeVisuals.push(shape)
    }
  }
  expand(group, { x: 0, y: 0, width, height }, 0)
  return shapeVisuals
}

async function readRelationships(read: ZipText, part: string): Promise<Relationships> {
  return new Map(parseRelationships(await read(relsPathFor(part))).flatMap(entry =>
    entry.id ? [[decodeAttribute(entry.id), entry]] : []
  ))
}

function internalTarget(rels: Relationships, part: string, id: string | undefined, ...kinds: string[]) {
  const rel = id && rels.get(id)
  if (!rel || rel.external || !kinds.some(kind => rel.type.endsWith(`/${kind}`))) return undefined
  const target = rel.target
  if (!target) return undefined
  try {
    return part === 'xl/workbook.xml' ? resolveWorkbookSheetTarget(target) : resolveRelTarget(part, target)
  } catch { return undefined }
}

async function readVmlDrawing(
  read: ZipText,
  sheetPath: string,
  sheetRels: Relationships,
  id: string | undefined,
) {
  const path = internalTarget(sheetRels, sheetPath, id, 'vmlDrawing')
  if (!path) return undefined
  const root = roots(await read(path))[0]
  if (!root) return undefined
  return { path, elements: [root, ...descendants(root)], relationships: await readRelationships(read, path) }
}

function previewPath(
  rels: Relationships, part: string, id: string | undefined, hasPart: (path: string) => boolean,
) {
  const path = internalTarget(rels, part, id, 'image')
  return path && visualMediaType(path) && hasPart(path) ? path : undefined
}

function shapeSvgEmbeds(blip: XmlElement | undefined): (string | undefined)[] {
  return children(child(blip, 'extLst')).filter(extension => extension.tag === 'ext').flatMap(extension =>
    // Only inspect the direct extension payload. The ordinary DrawingML
    // child reader intentionally omits non-DrawingML namespaces.
    elements(extension.tokens, extension.namespaces)
      .filter(payload => payload.tag === 'svgBlip' && payload.namespace === SVG_BLIP_NAMESPACE)
      .map(payload => relationshipAttribute(payload, 'embed')),
  )
}

function svgEmbedsPreview(ids: (string | undefined)[], references: DrawingReferences): string | undefined {
  for (const id of ids) {
    const path = previewPath(references.relationships, references.part, id, references.hasPart)
    if (path?.startsWith('xl/media/') && visualMediaType(path) === 'image/svg+xml') return path
  }
}

function vmlImageId(node: XmlElement | undefined) {
  return attribute(node, 'relid') ?? attribute(node, 'id')
}

function vmlSize(style: string | undefined) {
  const lengths = new Map<string, number>()
  const factors: Record<string, number> = { '': 1, pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, px: 0.75, pc: 12 }
  for (const declaration of style?.split(';') ?? []) {
    const [key, value] = declaration.split(':')
    const dimension = key?.trim().toLowerCase()
    if (dimension !== 'width' && dimension !== 'height') continue
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(pt|in|cm|mm|px|pc)?$/i.exec(value?.trim() ?? '')
    if (!match) continue
    const points = Number(match[1]) * factors[(match[2] ?? '').toLowerCase()]!
    if (points > 0 && points <= 2_000) lengths.set(dimension, points)
  }
  const widthPt = lengths.get('width'), heightPt = lengths.get('height')
  return widthPt && heightPt ? { widthPt, heightPt } : undefined
}

type HeaderFooterPicture = NonNullable<WorkbookPagePrintSettings['headerFooterPictures']>[number]

export async function readHeaderFooterPictures(
  read: ZipText, sheetPath: string, sheetIndex: number, hasPart: (path: string) => boolean,
): Promise<(HeaderFooterPicture & { mediaPath: string })[]> {
  const worksheet = worksheetVisualRoot(await read(sheetPath))
  const relationshipId = relationshipAttribute(child(worksheet, 'legacyDrawingHF'), 'id')
  if (!relationshipId) return []
  const vml = await readVmlDrawing(read, sheetPath, await readRelationships(read, sheetPath), relationshipId)
  const pictures = new Map<string, HeaderFooterPicture & { mediaPath: string }>()
  if (!vml) return []
  for (const node of vml.elements) {
    if (node.tag !== 'shape') continue
    const position = attribute(node, 'id')?.trim().toUpperCase()
    if (!position || !/^[LCR][HF](?:EVEN|FIRST)?$/.test(position) || pictures.has(position)) continue
    const size = vmlSize(attribute(node, 'style'))
    const mediaPath = previewPath(vml.relationships, vml.path, vmlImageId(child(node, 'imagedata')), hasPart)
    const mediaType = mediaPath && visualMediaType(mediaPath)
    if (!size || !mediaPath || !mediaType) continue
    pictures.set(position, { id: 'hf-picture-' + sheetIndex + '-' + position.toLowerCase(), position, ...size, mediaPath, mediaType })
  }
  return [...pictures.values()]
}

function vmlAnchor(value: string | undefined): Anchor | undefined {
  const coordinates = value?.split(',').map(integer)
  if (coordinates?.length !== 8 || coordinates.some(coordinate => coordinate === undefined)) return undefined
  const [fromColumn, fromColumnPx, fromRow, fromRowPx, toColumn, toColumnPx, toRow, toRowPx] = coordinates as [
    number, number, number, number, number, number, number, number,
  ]
  if (Math.min(fromColumn, fromRow, toColumn, toRow) < 0 || Math.max(fromRow, toRow) >= 1_048_576 ||
      Math.max(fromColumn, toColumn) >= 16_384) return undefined
  const offsets = [fromColumnPx, fromRowPx, toColumnPx, toRowPx].map(value => value * 9525)
  if (!offsets.every(Number.isSafeInteger)) return undefined
  return { fromColumn, fromRow, toColumn, toRow, fromColumnOffset: offsets[0]!, fromRowOffset: offsets[1]!,
    toColumnOffset: offsets[2]!, toRowOffset: offsets[3]!, explicitTo: true }
}

function vmlPaint(node: XmlElement, inherited: XmlElement | undefined, flag: string, attr: string, fallback: string) {
  const value = attribute(node, flag) ?? attribute(inherited, flag)
  if (value === 'f' || value === 'false' || value === '0') return undefined
  const color = attribute(node, attr)?.trim().split(/\s/, 1)[0]
  return color && /^#[a-f0-9]{6}$/i.test(color) ? color.toUpperCase() : fallback
}

type OleObject = Pick<WorkbookVisualObject, 'progId' | 'mediaPath' | 'lineColor' | 'fillColor'> & { anchor?: Anchor | undefined }

async function readOleObjects(
  read: ZipText, worksheet: XmlElement | undefined, sheetPath: string, sheetRels: Relationships,
  hasPart: (path: string) => boolean,
): Promise<Map<number, OleObject>> {
  const objects = new Map<number, OleObject>()
  for (const node of descendants(child(worksheet, 'oleObjects'))) {
    if (node.tag !== 'oleObject') continue
    const shapeId = nonnegative(attribute(node, 'shapeId'))
    const progId = attribute(node, 'progId')
    if (shapeId === undefined || !progId) continue
    const properties = child(node, 'objectPr')
    const anchor = child(properties, 'anchor')
    const existing = objects.get(shapeId)
    objects.set(shapeId, {
      progId: existing?.progId ?? progId,
      anchor: existing?.anchor ?? (anchor && readAnchor(anchor, child, text, attribute)),
      mediaPath: existing?.mediaPath ?? previewPath(sheetRels, sheetPath, relationshipAttribute(properties, 'id'), hasPart),
    })
  }
  if (!objects.size) return objects
  const vml = await readVmlDrawing(read, sheetPath, sheetRels, relationshipAttribute(child(worksheet, 'legacyDrawing'), 'id'))
  if (!vml) return objects
  const types = new Map(vml.elements.filter(node => node.tag === 'shapetype').map(node => ['#' + attribute(node, 'id'), node]))
  for (const node of vml.elements) {
    if (node.tag !== 'shape') continue
    const id = /_s(\d+)$/.exec(attribute(node, 'id') ?? '')?.[1]
    const object = id === undefined ? undefined : objects.get(Number(id))
    if (!object) continue
    const inherited = types.get(attribute(node, 'type') ?? '')
    object.anchor ??= vmlAnchor(text(first(node, 'Anchor')))
    object.mediaPath ??= previewPath(vml.relationships, vml.path, vmlImageId(first(node, 'imagedata')), hasPart)
    object.lineColor = vmlPaint(node, inherited, 'stroked', 'strokecolor', '#000000')
    object.fillColor = vmlPaint(node, inherited, 'filled', 'fillcolor', '#FFFFFF')
  }
  return objects
}

async function readControlCaptions(read: ZipText, sheetPath: string, relationships: Relationships) {
  const captions = new Map<string, string>()
  for (const [id, relation] of relationships) {
    const kind = relation.type.split('/').at(-1)
    if (kind !== 'slicer' && kind !== 'timeline') continue
    const path = internalTarget(relationships, sheetPath, id, kind)
    if (!path) continue
    for (const root of roots(await read(path))) {
      for (const node of [root, ...descendants(root)]) {
        if (node.tag !== kind) continue
        const name = attribute(node, 'name'), caption = attribute(node, 'caption')
        if (name && caption !== undefined) captions.set(name, caption)
      }
    }
  }
  return captions
}

function controlName(anchor: XmlElement) {
  for (const node of descendants(anchor)) {
    if (node.tag === 'graphicData' && /\/(?:slicer|timeslicer)$/.test(attribute(node, 'uri') ?? '')) {
      const name = attribute(children(node)[0], 'name')
      if (name) return name
    }
  }
}

export async function readWorkbookVisuals(
  read: ZipText,
  sheets: readonly { id: string; name: string }[],
  theme: readonly string[] = [],
  hasPart: (path: string) => boolean = () => true,
  lookup: SourceNumberFormat = () => undefined,
): Promise<WorkbookVisualObject[]> {
  const workbook = 'xl/workbook.xml'
  const byName = new Map(sheets.map(sheet => [sheet.name, sheet.id]))
  const workbookRels = await readRelationships(read, workbook)
  const result: WorkbookVisualObject[] = []
  let ordinal = 0
  let oleOrdinal = 0
  for (const declaration of parseSheetElements(await read(workbook))) {
    const sheetId = byName.get(declaration.name)
    const relationshipId = declaration.relationshipId === undefined ? undefined : decodeAttribute(declaration.relationshipId)
    const sheetPath = internalTarget(workbookRels, workbook, relationshipId, 'worksheet', 'chartsheet')
    if (!sheetId || !sheetPath) continue
    const sheetXml = await read(sheetPath)
    if (!sheetXml.includes('drawing') && !sheetXml.includes('oleObjects')) continue
    const sheet = worksheetVisualRoot(sheetXml)
    const sheetRels = await readRelationships(read, sheetPath)
    const captions = await readControlCaptions(read, sheetPath, sheetRels)
    const oleObjects = await readOleObjects(read, sheet, sheetPath, sheetRels, hasPart)
    const appendOle = (object: OleObject, fallback?: Anchor) => {
      const anchor = object.anchor ?? fallback
      if (!anchor || (anchor.fromRow === anchor.toRow && anchor.fromColumn === anchor.toColumn &&
        anchor.fromRowOffset === anchor.toRowOffset && anchor.fromColumnOffset === anchor.toColumnOffset)) return
      result.push({ ...object, id: 'ole-' + ++oleOrdinal, sheetId, kind: 'ole', anchor,
        mediaType: object.mediaPath ? visualMediaType(object.mediaPath) : undefined })
    }
    const renderedOle = new Set<number>()
    for (const node of children(sheet).filter(node => node.tag === 'drawing')) {
      const drawingPath = internalTarget(sheetRels, sheetPath, relationshipAttribute(node, 'id'), 'drawing')
      if (!drawingPath || !/^xl\/drawings\/[\w./-]+\.xml$/.test(drawingPath)) continue
      const drawingXml = await read(drawingPath)
      const drawingRels = await readRelationships(read, drawingPath)
      const references = { relationships: drawingRels, part: drawingPath, hasPart }
      for (const [drawingIndex, slot] of [...drawingAnchorElements(drawingXml)].entries()) {
        const id = `visual-${++ordinal}`
        if (drawingIndex > 10_000) break
        // Compatibility branches and opaque nodes count as physical slots.
        if (!slot.topLevel || !slot.editable) continue
        const entry = roots(slot.element.xml, slot.element.namespaces)[0]
        if (!entry) continue
        const anchor = readDrawingAnchor(slot.element)
        const nonvisual = drawingNonVisualProperties(slot.element)?.node
        const shapeNode = sheetDrawingChild(entry, 'sp') ?? sheetDrawingChild(entry, 'cxnSp')
        const shapeId = shapeNode && nonnegative(nonvisual?.attributes.get('id'))
        const ole = shapeId === undefined ? undefined : oleObjects.get(shapeId)
        if (ole && shapeId !== undefined) {
          if (!renderedOle.has(shapeId)) appendOle(ole, anchor)
          renderedOle.add(shapeId)
          continue
        }
        if (!anchor || ['1', 'true'].includes(nonvisual?.attributes.get('hidden') ?? '')) continue
        const control = controlName(entry)
        if (control) {
          result.push({ id, sheetId, kind: 'slicer', anchor, name: control, text: captions.get(control) ?? control })
          continue
        }
        const name = nonvisual?.attributes.get('name')
        const editAs = entry.tag === 'twoCellAnchor'
          ? member(attribute(entry, 'editAs'), ['twoCell', 'oneCell', 'absolute'] as const) ?? 'twoCell' : undefined
        const altText = nonvisual?.attributes.get('descr') || undefined
        const hyperlink = drawingHyperlink(drawingRelationshipAttribute(drawingMainChild(nonvisual, 'hlinkClick'), 'id'), drawingRels)
        const base = { id, sheetId, anchor, name, drawingPath, drawingIndex, editAs, altText, ...(hyperlink ? { hyperlink } : {}) }
        const group = child(entry, 'grpSp')
        if (group) {
          for (const shape of readGroupShapes(group, base, theme, references)) result.push(shape)
          continue
        }
        const graphicFrame = readDrawingGraphicFrame(slot.element)
        if (graphicFrame) {
          const chartPath = internalTarget(drawingRels, drawingPath, graphicFrame.chartRelationshipId, 'chart')
          if (!chartPath || !WORKBOOK_CHART_PATH.test(chartPath) || !hasPart(chartPath)) continue
          const chart = readChart(await read(chartPath), theme, lookup)
          if (chart) result.push({ ...base, kind: 'chart', chartPath, chart })
          continue
        }
        if (shapeNode) {
          const shape = readShape(shapeNode, base, theme, references)
          if (shape) result.push(shape)
          continue
        }
        const picture = readDrawingPicture(slot.element)
        if (!picture?.blip) continue
        const embed = drawingRelationshipAttribute(picture.blip, 'embed')
        const primary = previewPath(drawingRels, drawingPath, embed, hasPart)
        const mediaPath = primary?.startsWith('xl/media/') ? primary : svgEmbedsPreview(
          pictureExtensionBlips(picture.blip).map(blip => drawingRelationshipAttribute(blip, 'embed')),
          references,
        )
        if (!mediaPath) continue
        const mediaType = visualMediaType(mediaPath)
        if (!mediaType || (anchor.fromRow === anchor.toRow && anchor.fromColumn === anchor.toColumn &&
          anchor.fromRowOffset === anchor.toRowOffset && anchor.fromColumnOffset === anchor.toColumnOffset)) continue
        const xfrm = drawingMainChild(drawingChild(picture.picture, 'spPr'), 'xfrm')
        const rotation = finite(xfrm?.attributes.get('rot'))
        const frame = rotation ? drawingMainChild(xfrm, 'ext') : undefined
        const frameWidth = finite(frame?.attributes.get('cx'))
        const frameHeight = finite(frame?.attributes.get('cy'))
        result.push({ ...base, kind: 'image', mediaPath, mediaType,
          opacity: blipOpacity(drawingMainChild(picture.blip, 'alphaModFix')?.attributes.get('amt')),
          crop: pictureCrop(picture.fill), rotation: rotation ? rotation / 60_000 : undefined,
          flipH: ['1', 'true'].includes(xfrm?.attributes.get('flipH') ?? ''), flipV: ['1', 'true'].includes(xfrm?.attributes.get('flipV') ?? ''),
          frameWidth: frameWidth && frameWidth > 0 ? frameWidth : undefined,
          frameHeight: frameHeight && frameHeight > 0 ? frameHeight : undefined,
        })
      }
    }
    for (const [shapeId, object] of oleObjects) {
      if (!renderedOle.has(shapeId)) appendOle(object)
    }
  }
  return result
}
