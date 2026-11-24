/// Declarative conditional-formatting save: the renderer snapshots the full
/// Univer rule set of a dirty sheet and this module rewrites every
/// `<conditionalFormatting>` section from it (mirroring the filter recipe).
/// Highlight styles intern as new dxf entries in the stylesheet.

import { decodeAttribute } from './xlsx-sheets.ts'
import { findRootChild } from './xlsx-root-tail.ts'
import { childElements } from './xlsx-style-entries.ts'

export class CfEditError extends Error {}

export interface CfCellArea {
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
}

/// One rule in the Univer conditional-formatting model shape (validated
/// structurally here — unknown shapes fail the save rather than guess).
export interface CfWireRule {
  readonly ranges: readonly CfCellArea[]
  readonly stopIfTrue: boolean
  readonly rule: Record<string, unknown>
  readonly source?: { readonly priority: number; readonly unchanged: boolean } | undefined
}

export interface DxfSink {
  internDxf(dxfXml: string): number
}

/// OOXML-representable icon sets; Univer's extras (3Triangles, 3Stars,
/// 5Boxes, …) are x14-only and fail closed.
export const OOXML_ICON_SETS = new Set([
  '3Arrows',
  '3ArrowsGray',
  '3Flags',
  '3TrafficLights1',
  '3TrafficLights2',
  '3Signs',
  '3Symbols',
  '3Symbols2',
  '4Arrows',
  '4ArrowsGray',
  '4RedToBlack',
  '4Rating',
  '4TrafficLights',
  '5Arrows',
  '5ArrowsGray',
  '5Quarters',
  '5Rating',
])

/// Univer's iconMap lists most sets best-icon-first, but the rating sets run
/// worst-first, so their iconId sequence flips relative to the file order.
export const WORST_FIRST_ICON_SETS = new Set(['4Rating', '5Rating'])

/// Whether a Univer icon-set config round-trips to base OOXML: one
/// whitelisted set with icons in natural or fully reversed order.
export function iconSetSaveable(config: unknown): boolean {
  if (!Array.isArray(config) || config.length < 2) return false
  const entries = config as { iconType?: unknown; iconId?: unknown }[]
  const iconTypes = new Set(entries.map((entry) => String(entry?.iconType)))
  if (iconTypes.size !== 1 || !OOXML_ICON_SETS.has([...iconTypes][0] ?? '')) return false
  const ids = entries.map((entry) => String(entry?.iconId))
  return (
    ids.every((id, index) => id === String(index)) ||
    ids.every((id, index) => id === String(entries.length - 1 - index))
  )
}

/// Dry-runs the rule serializer so the UI can reject a rule the save would
/// fail closed on (same code path — zero drift). Returns the save-side error
/// message, or null when the rule is saveable.
export function cfRuleUnsaveableReason(rule: Record<string, unknown>): string | null {
  try {
    serializeCfRule(rule, 1, false, 'A1', { internDxf: () => 0 })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

interface PreservedBlock {
  readonly sqref: string
  readonly text: string
  matched: boolean
}

export interface CfApplyOptions {
  /** keep every existing section and add the rules after them (headless callers without the full rule set) */
  readonly append?: boolean | undefined
  /** Keep rules the Web editor cannot include in its snapshot. */
  readonly preserveUneditable?: boolean | undefined
  readonly removedSourcePriorities?: readonly number[] | undefined
}

const CF_BLOCK_RE =
  /<conditionalFormatting\b[^>]*?\/>|<conditionalFormatting\b[^>]*>[\s\S]*?<\/conditionalFormatting>/g
const CORE_SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const XML_TAG_CONTENT = `(?:[^>"']|"[^"]*"|'[^']*')*?`
const XML_OPENING_TAG = new RegExp(`^<${XML_TAG_CONTENT}>`)
const EDITABLE_CF_TYPES = new Set([
  'cellIs',
  'expression',
  'containsText',
  'notContainsText',
  'beginsWith',
  'endsWith',
  'containsBlanks',
  'notContainsBlanks',
  'containsErrors',
  'notContainsErrors',
  'duplicateValues',
  'uniqueValues',
  'top10',
  'colorScale',
  'dataBar',
  'iconSet',
])
const CELL_IS_OPERATORS = new Set([
  'equal',
  'notEqual',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'between',
  'notBetween',
])

function cfAttribute(openingTag: string, name: string): string | undefined {
  for (const [, key, double, single] of openingTag.matchAll(
    /\s([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    const value = double ?? single
    if (key === name && value !== undefined) return decodeAttribute(value)
  }
}

function cfOpeningTag(xml: string): string {
  return XML_OPENING_TAG.exec(xml)?.[0] ?? ''
}

function spreadsheetCfPrefix(xml: string): string {
  const declarations = [...xml.matchAll(/\sxmlns:([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
  const used = new Set(
    [...xml.matchAll(/<([\w.-]+):(?:conditionalFormatting|cfRule)(?=[\s/>])/g)].map(
      ([, alias]) => alias,
    ),
  )
  const core = new Set(
    declarations
      .filter(([, , double, single]) => (double ?? single) === CORE_SPREADSHEET_NAMESPACE)
      .map(([, alias]) => alias!)
      .filter((alias) => used.has(alias)),
  )
  if (
    declarations.some(
      ([, alias, double, single]) =>
        core.has(alias!) && (double ?? single) !== CORE_SPREADSHEET_NAMESPACE,
    )
  ) {
    throw new CfEditError('Conditional formatting uses a rebound spreadsheet namespace prefix.')
  }
  return core.size === 0
    ? ''
    : `(?:${[...core].map((alias) => alias.replaceAll('.', '\\.') + ':').join('|')})`
}

function cfElement(tag: string, prefix: string): RegExp {
  return new RegExp(
    `<((?:${prefix})?)${tag}(?=[\\s/>])${XML_TAG_CONTENT}(?:\\/>|>[\\s\\S]*?<\\/\\1${tag}\\s*>)`,
    'g',
  )
}

function cfChildTag(xml: string, tag: string): string {
  return new RegExp(`<(?:[\\w.-]+:)?${tag}(?=[\\s/>])${XML_TAG_CONTENT}>`).exec(xml)?.[0] ?? ''
}

function cfEditKind(xml: string): {
  type: string
  mode: 'editable' | 'unsupported' | 'approximate'
} {
  const openingTag = cfOpeningTag(xml)
  const type = cfAttribute(openingTag, 'type')
  const result = (mode: 'editable' | 'unsupported' | 'approximate') => ({ type: type ?? '', mode })
  if (type === undefined || !EDITABLE_CF_TYPES.has(type)) return result('unsupported')
  if (type === 'cellIs') {
    const operator = cfAttribute(openingTag, 'operator')
    if (!CELL_IS_OPERATORS.has(operator ?? '')) return result('unsupported')
    const formulas = [
      ...xml.matchAll(/<(?:[\w.-]+:)?formula(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?formula\s*>/g),
    ]
    if (formulas.length < (operator === 'between' || operator === 'notBetween' ? 2 : 1))
      return result('unsupported')
    if (formulas.some(([, value]) => !value?.trim() || !Number.isFinite(Number(value))))
      return result('approximate')
  }
  if (type === 'iconSet') {
    const name = cfAttribute(cfChildTag(xml, 'iconSet'), 'iconSet') ?? '3TrafficLights1'
    if (!OOXML_ICON_SETS.has(name)) return result('approximate')
  }
  if (type === 'dataBar') {
    const bar = cfChildTag(xml, 'dataBar')
    // The UI can render these extents but the serializer cannot write them.
    if (
      cfAttribute(bar, 'minLength') !== undefined ||
      cfAttribute(bar, 'maxLength') !== undefined
    ) {
      return result('approximate')
    }
  }
  if (type === 'iconSet' || type === 'colorScale' || type === 'dataBar') {
    for (const [stop] of xml.matchAll(/<(?:[\w.-]+:)?cfvo(?=[\s/>])[^>]*>/g)) {
      const kind = cfAttribute(stop, 'type')
      const value = cfAttribute(stop, 'val')
      if (
        kind !== 'min' &&
        kind !== 'max' &&
        (!['num', 'percent', 'percentile'].includes(kind ?? '') ||
          !value?.trim() ||
          !Number.isFinite(Number(value)))
      ) {
        return result('approximate')
      }
    }
  }
  return result('editable')
}

export function applyCfRules(
  worksheetXml: string,
  rules: readonly CfWireRule[],
  dxfs: DxfSink,
  options: CfApplyOptions = {},
): string {
  if (options.append) return appendCfRules(worksheetXml, rules, dxfs)
  const prefix = options.preserveUneditable ? spreadsheetCfPrefix(worksheetXml) : ''
  const cfBlocks = options.preserveUneditable
    ? cfElement('conditionalFormatting', prefix)
    : CF_BLOCK_RE
  const cfRules = cfElement('cfRule', prefix)
  // Blocks whose cfRule carries an extLst are the base half of an x14
  // extension (linked via x14:id) — kept verbatim and guarded below. The
  // x14 part in the worksheet extLst is left alone except when a whole
  // block is deleted (see removeX14CfTwins).
  const preserved: PreservedBlock[] = []
  const approximate: { sqref: string; type: string; priority: number }[] = []
  const removed = new Set(options.removedSourcePriorities)
  const deletedTwins: PreservedBlock[] = []
  const editablePriorities = new Set<number>()
  let keptUneditable = false
  let xml = worksheetXml.replace(cfBlocks, (block) => {
    const extended = /<(?:[\w.-]+:)?extLst\b/.test(block)
    const sqref = cfAttribute(cfOpeningTag(block), 'sqref')
    if (options.preserveUneditable) {
      let keepBlock = false
      const filtered = block.replace(cfRules, (rule) => {
        const { type, mode } = cfEditKind(rule)
        const priority = Number(cfAttribute(cfOpeningTag(rule), 'priority'))
        const linked = /<(?:[\w.-]+:)?extLst\b/.test(rule)
        if (mode !== 'editable' || linked) {
          if (removed.has(priority)) {
            if (linked && sqref !== undefined)
              deletedTwins.push({ sqref, text: rule, matched: false })
            return ''
          }
          if (sqref !== undefined && (mode === 'approximate' || linked)) {
            approximate.push({ sqref: normalizeSqref(sqref), type, priority })
          }
          keptUneditable = keepBlock = true
          return rule
        }
        if (Number.isSafeInteger(priority) && priority > 0) editablePriorities.add(priority)
        return ''
      })
      return keepBlock ? filtered : ''
    }
    if (!extended) return ''
    if (sqref === undefined) throw new CfEditError(linkedMessage(block))
    preserved.push({ sqref, text: block, matched: false })
    return block
  })

  // x14 rules and preserved blocks keep their priorities; new rules take
  // max+1 values.
  const usedPriorities = new Set<number>()
  let priority = 0
  for (const match of xml.matchAll(/<(?:\w+:)?cfRule\b[^>]*>/g)) {
    const seen = Number(cfAttribute(match[0], 'priority'))
    if (!Number.isSafeInteger(seen) || seen <= 0) continue
    priority = Math.max(priority, seen)
    usedPriorities.add(seen)
  }
  // Keep the raw rules' precedence relative to existing editable rules.
  const reusable = keptUneditable
    ? [...editablePriorities].filter((value) => !usedPriorities.has(value)).sort((a, b) => a - b)
    : []
  priority = Math.max(priority, reusable.at(-1) ?? 0)
  let reused = 0
  const nextPriority = (): number => {
    if (reused < reusable.length) return reusable[reused++]!
    priority += 1
    return priority
  }

  const sections: string[] = []
  const retainedPriorities = new Map(approximate.map((item) => [item.priority, item]))
  let previousSource = 0
  let previousRetained = 0
  for (const rule of rules) {
    const sqref = rule.ranges.map(toRef).join(' ')
    const normalized = normalizeSqref(sqref)
    const sourcePriority = rule.source?.priority ?? 0
    const source = sourcePriority > 0 ? retainedPriorities.get(sourcePriority) : undefined
    if (sourcePriority > 0) {
      if ((source && sourcePriority < previousSource) || sourcePriority < previousRetained) {
        throw new CfEditError('This conditional formatting rule must keep its original priority.')
      }
      previousSource = Math.max(sourcePriority, previousSource)
      if (source) previousRetained = sourcePriority
    }
    if (source && rule.source?.unchanged && source.sqref === normalized) continue
    if (
      source ||
      (!rule.source &&
        approximate.some(
          (item) =>
            item.sqref === normalized &&
            (item.type === rule.rule.type ||
              (item.type === 'cellIs' && rule.rule.type === 'highlightCell')),
        ))
    ) {
      throw new CfEditError(
        'This range has conditional formatting that cannot be edited without losing its original settings.',
      )
    }
    const linked = preserved.find(
      (block) => !block.matched && normalizeSqref(block.sqref) === normalized,
    )
    if (linked) {
      // Only a byte-identical round trip proves the rule is unchanged; any
      // difference means the extension's base half was edited.
      const original = /<cfRule\b[^>]*?\spriority="(\d+)"/.exec(linked.text)
      const bare = linked.text.replace(/<extLst\b[\s\S]*?<\/extLst>/, '')
      let probe: string | null
      try {
        probe = original === null ? null : serializeRule(rule, Number(original[1]), dxfs)
      } catch {
        probe = null
      }
      const normBare = bare.replace(/\bsqref="([^"]*)"/, (_, s) => `sqref="${normalizeSqref(s)}"`)
      const normProbe = probe?.replace(
        /\bsqref="([^"]*)"/,
        (_, s) => `sqref="${normalizeSqref(s)}"`,
      )
      if (normProbe !== normBare) throw new CfEditError(linkedMessage(linked.text))
      linked.matched = true
      continue
    }
    sections.push(serializeRule(rule, nextPriority(), dxfs))
  }
  // A preserved block the snapshot no longer carries was deleted in the UI
  // (or the sheet's CF was cleared): drop both halves — the base block here
  // and its twin in the worksheet extLst — instead of failing the whole
  // save, which blocked unrelated table/filter/theme edits on files that
  // carry an x14 bar (issue #2510). Edits to a surviving block still fail
  // closed above so the extension's refinements are never silently lost.
  const deleted = preserved.filter((block) => !block.matched)
  if (deleted.length > 0) {
    for (const block of deleted) {
      const at = xml.indexOf(block.text)
      if (at !== -1) xml = xml.slice(0, at) + xml.slice(at + block.text.length)
    }
  }
  xml = removeX14CfTwins(xml, [...deleted, ...deletedTwins])

  if (sections.length === 0) return xml
  const body = sections.join('')
  const last = [...xml.matchAll(cfBlocks)].at(-1)
  if (last) {
    const end = last.index + last[0].length
    return xml.slice(0, end) + body + xml.slice(end)
  }
  return insertBeforeTail(xml, body)
}

function appendCfRules(xml: string, rules: readonly CfWireRule[], dxfs: DxfSink): string {
  if (rules.length === 0) return xml
  let priority = 0
  for (const match of xml.matchAll(/<(?:\w+:)?cfRule\b[^>]*?\spriority="(\d+)"/g)) {
    const seen = Number(match[1])
    if (seen > priority) priority = seen
  }
  const nextPriority = (): number => {
    priority += 1
    return priority
  }
  const body = rules.map((rule) => serializeRule(rule, nextPriority(), dxfs)).join('')
  let end = -1
  for (const block of xml.matchAll(CF_BLOCK_RE)) end = block.index + block[0].length
  if (end !== -1) return xml.slice(0, end) + body + xml.slice(end)
  return insertBeforeTail(xml, body)
}

function insertBeforeTail(xml: string, body: string): string {
  const anchor =
    /<dataValidations\b|<hyperlinks\b|<printOptions\b|<pageMargins\b|<pageSetup\b|<headerFooter\b|<rowBreaks\b|<colBreaks\b|<drawing\b|<legacyDrawing\b|<picture\b|<oleObjects\b|<tableParts\b|<extLst\b/.exec(
      xml,
    )
  if (anchor) return xml.slice(0, anchor.index) + body + xml.slice(anchor.index)
  const end = xml.lastIndexOf('</worksheet>')
  if (end === -1) throw new CfEditError('Worksheet has no closing element.')
  return xml.slice(0, end) + body + xml.slice(end)
}

function linkedMessage(block: string): string {
  return block.includes('type="dataBar"')
    ? 'This range has a data-bar extension format (x14) that cannot be modified yet'
    : 'This range has extended conditional formatting (x14) that cannot be modified yet'
}

/// The worksheet extLst extension carrying x14 conditional formatting.
/// The base halves live in <conditionalFormatting> blocks; the twins live
/// here linked by x14:id (mirroring how x14 data validation parks in its
/// own extension in xlsx-dv.ts).
const X14_CF_EXT_URI = '{78c0d931-6437-407d-a8ee-f0aad7539e65}'

/// Drops the x14 twins of deleted base blocks: the <x14:cfRule> entries in
/// the {78C0D931…} extension whose id matches a deleted block's <x14:id>,
/// or — when a deleted block carries no id — the whole
/// <x14:conditionalFormatting> entries whose <xm:sqref> matches it.
/// Entries, the wrapper, the extension and the extLst around it are
/// removed when a step empties them, so a deleted rule leaves no husk
/// Excel flags for repair.
function removeX14CfTwins(xml: string, deleted: readonly PreservedBlock[]): string {
  if (deleted.length === 0) return xml
  const position = findRootChild(xml, 'worksheet', 'extLst')
  if (!position) return xml
  const [list] = childElements(xml.slice(position.start, position.end))
  if (!list) return xml
  const extension = childElements(list.inner).find(
    (child) =>
      /(?:^|:)ext$/.test(child.name) &&
      cfAttribute(child.opening, 'uri')?.toLowerCase() === X14_CF_EXT_URI,
  )
  if (!extension) return xml
  const cleaned = cleanX14CfContent(extension.inner, deleted)
  if (cleaned === extension.inner) return xml
  const replacement = cleaned.trim()
    ? extension.opening +
      cleaned +
      extension.xml.slice(extension.opening.length + extension.inner.length)
    : ''
  const inner =
    list.inner.slice(0, extension.start) +
    replacement +
    list.inner.slice(extension.start + extension.xml.length)
  const wrapper = inner.trim()
    ? list.opening + inner + list.xml.slice(list.opening.length + list.inner.length)
    : ''
  return xml.slice(0, position.start) + wrapper + xml.slice(position.end)
}

function cleanX14CfContent(content: string, deleted: readonly PreservedBlock[]): string {
  const ids = new Set<string>()
  const sqrefOnly = new Set<string>()
  const prefix = '[\\w.-]+:'
  const innerText = (element: string) =>
    element.slice(cfOpeningTag(element).length, element.lastIndexOf('</')).trim()
  for (const block of deleted) {
    const blockIds = [...block.text.matchAll(cfElement('id', prefix))]
      .map(([element]) => innerText(element).toLowerCase())
      .filter(Boolean)
    if (blockIds.length === 0) sqrefOnly.add(normalizeSqref(block.sqref))
    else for (const id of blockIds) ids.add(id)
  }
  let out = content
  const rules = cfElement('cfRule', prefix)
  const groups = cfElement('conditionalFormatting', prefix)
  if (ids.size > 0) {
    out = out.replace(groups, (group) => {
      const updated = group.replace(rules, (rule) => {
        const id = cfAttribute(cfOpeningTag(rule), 'id')?.trim().toLowerCase()
        return id && ids.has(id) ? '' : rule
      })
      return updated !== group && !/<(?:[\w.-]+:)?cfRule(?=[\s/>])/.test(updated) ? '' : updated
    })
  }
  if (sqrefOnly.size > 0) {
    out = out.replace(groups, (group) => {
      const sqref = cfElement('sqref', prefix).exec(group)?.[0]
      return sqref && sqrefOnly.has(normalizeSqref(innerText(sqref))) ? '' : group
    })
  }
  if (out !== content) {
    out = out.replace(cfElement('conditionalFormattings', prefix), (wrapper) =>
      /<(?:[\w.-]+:)?conditionalFormatting(?=[\s/>])/.test(wrapper) ? wrapper : '',
    )
  }
  return out
}

function serializeRule(wireRule: CfWireRule, priority: number, dxfs: DxfSink): string {
  if (wireRule.ranges.length === 0) {
    throw new CfEditError('A conditional-formatting rule has no ranges.')
  }
  const sqref = wireRule.ranges.map(toRef).join(' ')
  const anchor = `${columnToLetters(wireRule.ranges[0]?.startColumn ?? 0)}${(wireRule.ranges[0]?.startRow ?? 0) + 1}`
  const cfRule = serializeCfRule(wireRule.rule, priority, wireRule.stopIfTrue, anchor, dxfs)
  return `<conditionalFormatting sqref="${sqref}">${cfRule}</conditionalFormatting>`
}

function serializeCfRule(
  rule: Record<string, unknown>,
  priority: number,
  stopIfTrue: boolean,
  anchor: string,
  dxfs: DxfSink,
): string {
  const type = rule.type
  if (type === 'colorScale') return colorScaleRule(rule, priority, stopIfTrue)
  if (type === 'dataBar') return dataBarRule(rule, priority, stopIfTrue)
  if (type === 'iconSet') return iconSetRule(rule, priority, stopIfTrue)
  if (type === 'highlightCell') return highlightRule(rule, priority, stopIfTrue, anchor, dxfs)
  throw new CfEditError(`Unsupported conditional-formatting rule type "${String(type)}".`)
}

function attributes(base: string, priority: number, stopIfTrue: boolean, dxfId?: number): string {
  return (
    `type="${base}"${dxfId === undefined ? '' : ` dxfId="${dxfId}"`} priority="${priority}"` +
    (stopIfTrue ? ' stopIfTrue="1"' : '')
  )
}

function highlightRule(
  rule: Record<string, unknown>,
  priority: number,
  stopIfTrue: boolean,
  anchor: string,
  dxfs: DxfSink,
): string {
  const dxfId = dxfs.internDxf(buildDxfXml(rule.style))
  const subType = rule.subType
  const value = rule.value
  const operator = typeof rule.operator === 'string' ? rule.operator : undefined
  const element = (attrs: string, formulas: readonly string[] = []): string => {
    const body = formulas.map((formula) => `<formula>${escapeXmlText(formula)}</formula>`).join('')
    return body === '' ? `<cfRule ${attrs}/>` : `<cfRule ${attrs}>${body}</cfRule>`
  }
  switch (subType) {
    case 'number': {
      if (operator === undefined) throw new CfEditError('A number rule needs an operator.')
      const values = Array.isArray(value) ? value : [value]
      const formulas = values.map((entry) => {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) {
          throw new CfEditError('A number rule needs finite values.')
        }
        return String(entry)
      })
      return element(
        `${attributes('cellIs', priority, stopIfTrue, dxfId)} operator="${operator}"`,
        formulas,
      )
    }
    case 'text': {
      const text = typeof value === 'string' ? value : ''
      const quoted = `"${text.replaceAll('"', '""')}"`
      switch (operator) {
        case 'containsText':
          return element(
            `${attributes('containsText', priority, stopIfTrue, dxfId)} operator="containsText" text="${escapeXmlAttribute(text)}"`,
            [`NOT(ISERROR(SEARCH(${quoted},${anchor})))`],
          )
        case 'notContainsText':
          return element(
            `${attributes('notContainsText', priority, stopIfTrue, dxfId)} operator="notContains" text="${escapeXmlAttribute(text)}"`,
            [`ISERROR(SEARCH(${quoted},${anchor}))`],
          )
        case 'beginsWith':
          return element(
            `${attributes('beginsWith', priority, stopIfTrue, dxfId)} operator="beginsWith" text="${escapeXmlAttribute(text)}"`,
            [`LEFT(${anchor},LEN(${quoted}))=${quoted}`],
          )
        case 'endsWith':
          return element(
            `${attributes('endsWith', priority, stopIfTrue, dxfId)} operator="endsWith" text="${escapeXmlAttribute(text)}"`,
            [`RIGHT(${anchor},LEN(${quoted}))=${quoted}`],
          )
        case 'equal':
          return element(`${attributes('cellIs', priority, stopIfTrue, dxfId)} operator="equal"`, [
            quoted,
          ])
        case 'notEqual':
          return element(
            `${attributes('cellIs', priority, stopIfTrue, dxfId)} operator="notEqual"`,
            [quoted],
          )
        case 'containsBlanks':
          return element(attributes('containsBlanks', priority, stopIfTrue, dxfId), [
            `LEN(TRIM(${anchor}))=0`,
          ])
        case 'notContainsBlanks':
          return element(attributes('notContainsBlanks', priority, stopIfTrue, dxfId), [
            `LEN(TRIM(${anchor}))>0`,
          ])
        case 'containsErrors':
          return element(attributes('containsErrors', priority, stopIfTrue, dxfId), [
            `ISERROR(${anchor})`,
          ])
        case 'notContainsErrors':
          return element(attributes('notContainsErrors', priority, stopIfTrue, dxfId), [
            `NOT(ISERROR(${anchor}))`,
          ])
        default:
          throw new CfEditError(`Unsupported text operator "${String(operator)}".`)
      }
    }
    case 'duplicateValues':
      return element(attributes('duplicateValues', priority, stopIfTrue, dxfId))
    case 'uniqueValues':
      return element(attributes('uniqueValues', priority, stopIfTrue, dxfId))
    case 'rank': {
      const rank = typeof value === 'number' && Number.isFinite(value) ? value : undefined
      if (rank === undefined) throw new CfEditError('A top/bottom rule needs a rank value.')
      return element(
        `${attributes('top10', priority, stopIfTrue, dxfId)}` +
          `${rule.isPercent === true ? ' percent="1"' : ''}` +
          `${rule.isBottom === true ? ' bottom="1"' : ''} rank="${rank}"`,
      )
    }
    case 'average': {
      // OOXML models above/below (with optional equality); exact equal /
      // notEqual to the average has no representation.
      const map: Record<string, string> = {
        greaterThan: '',
        greaterThanOrEqual: ' equalAverage="1"',
        lessThan: ' aboveAverage="0"',
        lessThanOrEqual: ' aboveAverage="0" equalAverage="1"',
      }
      const extra = operator === undefined ? undefined : map[operator]
      if (extra === undefined) {
        throw new CfEditError(`Average rule operator "${String(operator)}" cannot be saved.`)
      }
      return element(`${attributes('aboveAverage', priority, stopIfTrue, dxfId)}${extra}`)
    }
    case 'formula': {
      if (typeof value !== 'string' || value.length === 0) {
        throw new CfEditError('A formula rule needs a formula.')
      }
      return element(attributes('expression', priority, stopIfTrue, dxfId), [
        value.startsWith('=') ? value.slice(1) : value,
      ])
    }
    case 'timePeriod':
      throw new CfEditError('Date-occurring rules cannot be saved yet.')
    default:
      throw new CfEditError(`Unsupported highlight rule "${String(subType)}".`)
  }
}

function colorScaleRule(
  rule: Record<string, unknown>,
  priority: number,
  stopIfTrue: boolean,
): string {
  const config = rule.config
  if (!Array.isArray(config) || config.length < 2) {
    throw new CfEditError('A color scale needs at least two stops.')
  }
  const stops = [...config].sort(
    (left, right) => Number(left?.index ?? 0) - Number(right?.index ?? 0),
  )
  const cfvos = stops.map((stop) => serializeCfvo(stop?.value)).join('')
  const colors = stops
    .map(
      (stop) => `<color rgb="${toArgb(requireColor(stop?.color ?? '#FFFFFF', 'color scale'))}"/>`,
    )
    .join('')
  return (
    `<cfRule ${attributes('colorScale', priority, stopIfTrue)}>` +
    `<colorScale>${cfvos}${colors}</colorScale></cfRule>`
  )
}

function dataBarRule(rule: Record<string, unknown>, priority: number, stopIfTrue: boolean): string {
  const config = rule.config as Record<string, unknown> | undefined
  if (typeof config !== 'object' || config === null) {
    throw new CfEditError('A data bar rule has no configuration.')
  }
  const showValue = rule.isShowValue === false ? ' showValue="0"' : ''
  // The base schema stores one bar color; the negative color is x14-only and
  // is dropped.
  return (
    `<cfRule ${attributes('dataBar', priority, stopIfTrue)}>` +
    `<dataBar${showValue}>${serializeCfvo(config.min)}${serializeCfvo(config.max)}` +
    `<color rgb="${toArgb(requireColor(config.positiveColor ?? '#638EC6', 'data bar'))}"/></dataBar></cfRule>`
  )
}

function iconSetRule(rule: Record<string, unknown>, priority: number, stopIfTrue: boolean): string {
  const config = rule.config
  if (!Array.isArray(config) || config.length < 2) {
    throw new CfEditError('An icon set needs at least two thresholds.')
  }
  const iconTypes = new Set(config.map((entry) => String(entry?.iconType)))
  if (iconTypes.size !== 1) {
    throw new CfEditError('Mixed icon sets are extended-format-only and cannot be saved.')
  }
  const iconSet = [...iconTypes][0] ?? ''
  if (!OOXML_ICON_SETS.has(iconSet)) {
    throw new CfEditError(`The "${iconSet}" icon set cannot be saved to xlsx.`)
  }
  // Univer's config runs best-icon-first with descending thresholds (the
  // inverse of the file's ascending cfvo order — see the read-side install).
  const ascending = [...config].reverse()
  const iconIds = ascending.map((entry) => String(entry?.iconId))
  const upIds = ascending.map((_, index) => String(index))
  const downIds = ascending.map((_, index) => String(ascending.length - 1 - index))
  const [naturalIds, reversedIds] = WORST_FIRST_ICON_SETS.has(iconSet)
    ? [upIds, downIds]
    : [downIds, upIds]
  let reverse = ''
  if (iconIds.every((id, index) => id === reversedIds[index])) reverse = ' reverse="1"'
  else if (!iconIds.every((id, index) => id === naturalIds[index])) {
    throw new CfEditError('Custom icon orderings are extended-format-only and cannot be saved.')
  }
  const cfvos = ascending
    .map((entry, index) => {
      const gte = entry?.operator === 'greaterThan' ? ' gte="0"' : ''
      // The first threshold is the catch-all minimum.
      if (index === 0) return '<cfvo type="percent" val="0"/>'
      return serializeCfvo(entry?.value, gte)
    })
    .join('')
  const showValue = rule.isShowValue === false ? ' showValue="0"' : ''
  return (
    `<cfRule ${attributes('iconSet', priority, stopIfTrue)}>` +
    `<iconSet iconSet="${escapeXmlAttribute(iconSet)}"${showValue}${reverse}>${cfvos}</iconSet></cfRule>`
  )
}

function serializeCfvo(value: unknown, extra = ''): string {
  const config = value as { type?: unknown; value?: unknown } | undefined
  const type = String(config?.type ?? '')
  if (type === 'min' || type === 'max') return `<cfvo type="${type}"${extra}/>`
  if (!['num', 'percent', 'percentile', 'formula'].includes(type)) {
    throw new CfEditError(`Unsupported threshold type "${type}".`)
  }
  const raw = config?.value
  if (type === 'formula') {
    return `<cfvo type="formula" val="${escapeXmlAttribute(String(raw ?? '0'))}"${extra}/>`
  }
  // CT_Cfvo/@val is xsd:string, so val="NaN" passes schema but the rule never applies.
  const numeric = Number(raw ?? 0)
  if (!Number.isFinite(numeric)) {
    throw new CfEditError(`A ${type} threshold needs a finite value.`)
  }
  return `<cfvo type="${type}" val="${escapeXmlAttribute(String(numeric))}"${extra}/>`
}

/// Univer IStyleBase highlight style → dxf XML (font + solid fill).
export function buildDxfXml(style: unknown): string {
  const s = (typeof style === 'object' && style !== null ? style : {}) as Record<string, unknown>
  const fontParts: string[] = []
  if (s.bl === 1) fontParts.push('<b/>')
  if (s.it === 1) fontParts.push('<i/>')
  if (isLine(s.st)) fontParts.push('<strike/>')
  if (isLine(s.ul)) fontParts.push('<u/>')
  const fontColor = rgbOf(s.cl)
  if (fontColor) fontParts.push(`<color rgb="${toArgb(fontColor)}"/>`)
  const fillColor = rgbOf(s.bg)
  const font = fontParts.length === 0 ? '' : `<font>${fontParts.join('')}</font>`
  const fill =
    fillColor === undefined
      ? ''
      : `<fill><patternFill><bgColor rgb="${toArgb(fillColor)}"/></patternFill></fill>`
  return `<dxf>${font}${fill}</dxf>`
}

function isLine(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).s === 1
}

function rgbOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const rgb = (value as Record<string, unknown>).rgb
  return typeof rgb === 'string' ? parseColor(rgb) : undefined
}

/// Univer stores colors as hex OR ColorKit's `rgb(r,g,b)` string form.
function parseColor(input: string): string | undefined {
  const value = input.trim()
  const hex = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value)
  if (hex?.[1]) return `#${hex[1].toUpperCase()}`
  const rgb = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/.exec(value)
  if (!rgb) return undefined
  const channels = rgb
    .slice(1, 4)
    .map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0'))
    .join('')
  return `#${channels}`.toUpperCase()
}

function requireColor(input: unknown, what: string): string {
  const parsed = typeof input === 'string' ? parseColor(input) : undefined
  if (parsed === undefined) {
    throw new CfEditError(`The ${what} color "${String(input)}" cannot be saved.`)
  }
  return parsed
}

function toRef(range: CfCellArea): string {
  return range.startRow === range.endRow && range.startColumn === range.endColumn
    ? `${columnToLetters(range.startColumn)}${range.startRow + 1}`
    : `${columnToLetters(range.startColumn)}${range.startRow + 1}` +
        `:${columnToLetters(range.endColumn)}${range.endRow + 1}`
}

function normalizeSqref(sqref: string): string {
  return sqref
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const [a, b] = part.replace(/\$/g, '').toUpperCase().split(':')
      return b === undefined || b === a ? a! : `${a}:${b}`
    })
    .sort()
    .join(' ')
}

function columnToLetters(column: number): string {
  let letters = ''
  let remaining = column + 1
  while (remaining > 0) {
    remaining -= 1
    letters = String.fromCharCode(65 + (remaining % 26)) + letters
    remaining = Math.floor(remaining / 26)
  }
  return letters
}

function toArgb(hexColor: string): string {
  return `FF${hexColor.replace('#', '').toUpperCase()}`
}

function escapeXmlText(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeXmlAttribute(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
