/// Declarative data-validation save: the renderer snapshots the full Univer
/// rule set of a dirty sheet and this module rewrites the worksheet's
/// `<dataValidations>` section from it (mirroring the CF/filter recipe).
/// Mappings are the exact inverse of the read-side install in App.tsx.
/// Rules only xlsx's 2009 x14 extension can hold (a formula referencing
/// another sheet) ride in the worksheet extLst's x14:dataValidations block
/// instead, paired with nothing in the legacy section — the fallback shape
/// Excel itself writes for those rules.

import { MAX_GRID_COLUMNS, MAX_GRID_ROWS } from '../shared/grid-bounds.ts'
import { childElements } from './xlsx-style-entries.ts'
import {
  applyPatches,
  elementText,
  escapeXmlAttribute,
  escapeXmlText,
  extensionUri,
  isElement,
  patchElement,
  prefixOf,
  scopedChildren,
  withBody,
  withNamespaces,
  worksheetExtensions,
  worksheetRoot,
  X14_CF_EXT_URI,
  X14_XMLNS,
  XM_XMLNS,
  XML_ATTRIBUTE,
  type Attributes,
  type ScopedElement,
  type XmlPatch,
} from './xlsx-worksheet-xml.ts'

export class DvEditError extends Error {}

export interface DvCellArea {
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
}

/// One rule in the Univer data-validation model shape (validated structurally
/// here — unknown shapes fail the save rather than guess).
export interface DvWireRule {
  readonly ranges: readonly DvCellArea[]
  readonly rule: Record<string, unknown>
}

const DV_TYPES = new Set(['whole', 'decimal', 'list', 'date', 'time', 'textLength', 'custom'])
const DV_OPERATORS = new Set([
  'between',
  'notBetween',
  'equal',
  'notEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
])
/// Univer DataValidationErrorStyle: INFO=0, STOP=1 (OOXML default), WARNING=2.
const DV_ERROR_STYLE_NAMES: Record<number, string | undefined> = {
  0: 'information',
  1: undefined,
  2: 'warning',
}

/// The worksheet extLst extension carrying x14 data validations. Excel
/// declares it with this uri; the {78C0D931-…} extension is the x14
/// conditional-formatting one, and Excel ignores validation rules parked
/// there — so the block gets an extension of its own.
const X14_DV_EXT_URI = '{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}'
const DV_TAIL = new Set([
  'hyperlinks',
  'printOptions',
  'pageMargins',
  'pageSetup',
  'headerFooter',
  'rowBreaks',
  'colBreaks',
  'drawing',
  'legacyDrawing',
  'picture',
  'oleObjects',
  'tableParts',
  'extLst',
])

export interface DvApplyOptions {
  /** keep the existing rules, replace those on the same ranges, drop `remove`, add the rest */
  readonly append?: boolean | undefined
  readonly remove?: readonly DvCellArea[] | undefined
}

export function applyDvRules(
  worksheetXml: string,
  rules: readonly DvWireRule[],
  options: DvApplyOptions = {},
): string {
  const prepared = rules.map(prepareRule)
  const root = worksheetRoot(worksheetXml)
  if (!root || root.opening.endsWith('/>'))
    throw new DvEditError('Worksheet has no closing element.')
  const children = scopedChildren(root)
  const replaced = options.append
    ? new Set(
        [...rules.flatMap((rule) => rule.ranges), ...(options.remove ?? [])].map((area) =>
          normalizeRef(toRef(area)),
        ),
      )
    : undefined
  const patches: XmlPatch[] = []
  const extended = rewriteExtendedValidations(
    root,
    children,
    prepared.filter((rule) => rule.needsX14),
    replaced,
  )
  if (extended) patches.push(extended)

  const legacy = children.filter((child) => isElement(child, 'dataValidations', root.namespace))
  // Legacy fragment callers can pass a namespace-less validation section
  // after the worksheet. Merge those direct siblings back into the root.
  const tailStart = root.start + root.xml.length
  const trailing =
    root.namespace === '' && tailStart < worksheetXml.length
      ? childElements(worksheetXml.slice(tailStart))
          .filter((element) => element.name === 'dataValidations')
          .map((element) => withNamespaces(element, root.namespaces))
          .filter((element) => isElement(element, 'dataValidations', ''))
      : []
  const legacyEntries = [
    ...(replaced
      ? [...legacy, ...trailing].flatMap((section) =>
          scopedChildren(section)
            .filter((child) => isElement(child, 'dataValidation', root.namespace))
            .flatMap((entry) => {
              const ref = entry.attributes.get('sqref') ?? ''
              const remaining = remainingAreas(ref, replaced)
              if (!remaining) return []
              const markup =
                remaining === ref
                  ? entry.xml
                  : entry.xml.replace(
                      /\ssqref\s*=\s*(?:"[^"]*"|'[^']*')/,
                      () => ` sqref="${escapeXmlAttribute(remaining)}"`,
                    )
              return [qualifyMovedEntry(entry, markup, root.namespaces)]
            }),
        )
      : []),
    ...prepared
      .filter((rule) => !rule.needsX14)
      .map((rule) => legacyEntry(rule, prefixOf(root.name))),
  ]
  const legacyTag = prefixOf(root.name) + 'dataValidations'
  const legacyBlock =
    legacyEntries.length > 0
      ? `<${legacyTag} count="${legacyEntries.length}">${legacyEntries.join('')}</${legacyTag}>`
      : ''
  if (legacy.length > 0) {
    legacy.forEach((section, index) =>
      patches.push(patchElement(section, index === 0 ? legacyBlock : '')),
    )
  } else if (legacyBlock) {
    const anchor = children.find(
      (child) => child.namespace === root.namespace && DV_TAIL.has(child.local),
    )
    patches.push({ start: anchor?.start ?? root.inner.length, length: 0, xml: legacyBlock })
  }
  return applyPatches(worksheetXml, [
    patchElement(root, withBody(root, applyPatches(root.inner, patches))),
    ...trailing.map((section) => ({
      start: tailStart + section.start,
      length: section.xml.length,
      xml: '',
    })),
  ])
}

/** `A1:A1` and `$A$1` name the same cell as `A1`; `A:A` / `1:1` expand to the full grid. */
function normalizeRef(ref: string): string {
  const [a, b] = ref.replace(/\$/g, '').toUpperCase().split(':')
  if (b !== undefined) {
    if (/^[A-Z]+$/.test(a!) && /^[A-Z]+$/.test(b)) return `${a}1:${b}${MAX_GRID_ROWS}`
    if (/^\d+$/.test(a!) && /^\d+$/.test(b))
      return `A${a}:${columnToLetters(MAX_GRID_COLUMNS - 1)}${b}`
  }
  return b === undefined || b === a ? a! : `${a}:${b}`
}

/// One wire rule after validation and normalization, holding the OOXML-level
/// formula texts once (shared by the legacy and x14 serializers) and the
/// verdict on which of the two shapes can carry it.
interface PreparedRule {
  readonly ranges: readonly DvCellArea[]
  /** OOXML type; undefined is the attribute-less "any" form */
  readonly type: string | undefined
  readonly rule: Record<string, unknown>
  readonly formula1: string | undefined
  readonly formula2: string | undefined
  readonly needsX14: boolean
}

function prepareRule(wireRule: DvWireRule): PreparedRule {
  if (wireRule.ranges.length === 0) {
    throw new DvEditError('A data-validation rule has no ranges.')
  }
  let rule = wireRule.rule
  let rawType = String(rule.type ?? '')
  if (rawType === 'listMultiple') {
    throw new DvEditError(
      'Multi-select list rules are Univer-only and cannot be saved to xlsx — ' +
        'delete the rule before saving.',
    )
  }
  if (rawType === 'checkbox') {
    // Checkbox is Univer-only; degrade to a two-value list so Excel keeps the
    // constraint. The default 1/0 pair round-trips back to a checkbox on load.
    const checked =
      rule.formula1 === undefined || rule.formula1 === '' ? '1' : String(rule.formula1)
    const unchecked =
      rule.formula2 === undefined || rule.formula2 === '' ? '0' : String(rule.formula2)
    rule = {
      ...rule,
      type: 'list',
      operator: undefined,
      formula1: `${checked},${unchecked}`,
      formula2: undefined,
    }
    rawType = 'list'
  }
  // 'any' is the read-side mapping of OOXML type="none" (no constraint, just
  // messages); it round-trips back to the default, attribute-less form.
  const type = rawType === 'any' || rawType === 'none' ? undefined : rawType
  if (type !== undefined && !DV_TYPES.has(type)) {
    throw new DvEditError(`Unsupported data-validation type "${rawType}".`)
  }
  const operator = rule.operator === undefined ? undefined : String(rule.operator)
  if (operator !== undefined && operator !== '') {
    if (!DV_OPERATORS.has(operator)) {
      throw new DvEditError(`Unsupported data-validation operator "${operator}".`)
    }
  }
  errorStyleName(rule.errorStyle)
  const formula1 = formulaText(type, rule.formula1)
  const formula2 = formulaText(type, rule.formula2)
  return {
    ranges: wireRule.ranges,
    type,
    rule,
    formula1,
    formula2,
    needsX14: needsX14Extension(type, rule, formula1, formula2),
  }
}

/// The one feature the 2006 legacy grammar cannot hold: a formula qualified
/// with a sheet name. Excel parks exactly those rules in the x14 extension
/// (leaving no legacy twin), so the save matches that shape. A list literal
/// is only ever a reference when the model value starts with `=`.
function needsX14Extension(
  type: string | undefined,
  rule: Record<string, unknown>,
  formula1: string | undefined,
  formula2: string | undefined,
): boolean {
  if (type === 'list') {
    return String(rule.formula1 ?? '').startsWith('=') && sheetQualified(formula1)
  }
  return sheetQualified(formula1) || sheetQualified(formula2)
}

/// A `!` behind a sheet name (quoted, bare, or a 3-D pair) qualifies the
/// reference onto another sheet; an in-sheet formula has no such token.
const SHEET_QUALIFIED_RE =
  /(?:^|[^A-Za-z0-9_.])(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)(?::(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*))?!/

function sheetQualified(formula: string | undefined): boolean {
  return formula !== undefined && SHEET_QUALIFIED_RE.test(formula)
}

/// Attributes shared verbatim by the legacy and x14 entry forms.
function entryAttributes(prepared: PreparedRule): string[] {
  const attrs: string[] = []
  const { type, rule } = prepared
  if (type !== undefined) attrs.push(`type="${type}"`)
  const operator = rule.operator === undefined ? undefined : String(rule.operator)
  if (operator !== undefined && operator !== '') {
    // "between" is the OOXML default; only operator-carrying types keep it.
    if (operator !== 'between' && type !== undefined && type !== 'list' && type !== 'custom') {
      attrs.push(`operator="${operator}"`)
    }
  }
  if (rule.allowBlank === true) attrs.push('allowBlank="1"')
  // OOXML's showDropDown="1" SUPPRESSES the in-cell dropdown (inverted name);
  // Univer's showDropDown means what it says.
  if (type === 'list' && rule.showDropDown === false) attrs.push('showDropDown="1"')
  if (rule.showInputMessage === true) attrs.push('showInputMessage="1"')
  if (rule.showErrorMessage === true) attrs.push('showErrorMessage="1"')
  const errorStyle = errorStyleName(rule.errorStyle)
  if (errorStyle !== undefined) attrs.push(`errorStyle="${errorStyle}"`)
  for (const [key, attribute] of [
    ['errorTitle', 'errorTitle'],
    ['error', 'error'],
    ['promptTitle', 'promptTitle'],
    ['prompt', 'prompt'],
  ] as const) {
    const value = rule[key]
    if (typeof value === 'string' && value.length > 0) {
      attrs.push(`${attribute}="${escapeXmlAttribute(value)}"`)
    }
  }
  return attrs
}

function legacyEntry(prepared: PreparedRule, prefix: string): string {
  const attrs = [...entryAttributes(prepared), `sqref="${prepared.ranges.map(toRef).join(' ')}"`]
  const formulas = legacyFormulas(prepared, prefix)
  return formulas === ''
    ? `<${prefix}dataValidation ${attrs.join(' ')}/>`
    : `<${prefix}dataValidation ${attrs.join(' ')}>${formulas}</${prefix}dataValidation>`
}

function legacyFormulas(prepared: PreparedRule, prefix: string): string {
  return (
    (prepared.formula1 === undefined
      ? ''
      : `<${prefix}formula1>${escapeXmlText(prepared.formula1)}</${prefix}formula1>`) +
    (prepared.formula2 === undefined
      ? ''
      : `<${prefix}formula2>${escapeXmlText(prepared.formula2)}</${prefix}formula2>`)
  )
}

/// The x14 twin: same attributes, formulas wrapped one level deeper in
/// <xm:f>, and the ranges as an <xm:sqref> child instead of an attribute.
function x14Entry(prepared: PreparedRule): string {
  const formulas =
    (prepared.formula1 === undefined
      ? ''
      : `<x14:formula1><xm:f>${escapeXmlText(prepared.formula1)}</xm:f></x14:formula1>`) +
    (prepared.formula2 === undefined
      ? ''
      : `<x14:formula2><xm:f>${escapeXmlText(prepared.formula2)}</xm:f></x14:formula2>`)
  const attrs = entryAttributes(prepared).join(' ')
  return (
    `<x14:dataValidation ${attrs}>${formulas}` +
    `<xm:sqref>${prepared.ranges.map(toRef).join(' ')}</xm:sqref></x14:dataValidation>`
  )
}

function remainingAreas(ref: string, replaced: ReadonlySet<string>): string {
  const areas = ref.trim().split(/\s+/).filter(Boolean)
  const remaining = areas.filter((area) => !replaced.has(normalizeRef(area)))
  return remaining.length === areas.length && remaining.length > 0 ? ref : remaining.join(' ')
}

/// An appended entry can outlive the section that bound its aliases.
function qualifyMovedEntry(entry: ScopedElement, xml: string, target: Attributes): string {
  const declarations: string[] = []
  for (const [alias, namespace] of entry.namespaces) {
    const key = alias ? 'xmlns:' + alias : 'xmlns'
    if (entry.attributes.has(key) || target.get(alias) === namespace) continue
    declarations.push(' ' + key + '="' + escapeXmlAttribute(namespace) + '"')
  }
  if (declarations.length === 0) return xml
  const opening = /^<(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(xml)?.[0] ?? entry.opening
  const position = opening.length - (opening.endsWith('/>') ? 2 : 1)
  return xml.slice(0, position) + declarations.join('') + xml.slice(position)
}

function validationSections(extension: ScopedElement): ScopedElement[] {
  return scopedChildren(extension).filter((child) => isElement(child, 'dataValidations', X14_XMLNS))
}

/// Replay worksheet edits on the x14 rules in place, preserving aliases and
/// extension payloads. An empty target removes its validation.
export function rewriteX14DataValidations(
  xml: string,
  rewriteFormula: (formula: string) => string,
  rewriteSqref?: (sqref: string) => string | null,
): string {
  if (!xml.includes('dataValidations') || !xml.includes('extLst')) return xml
  const root = worksheetRoot(xml)
  if (!root) return xml
  const { list, extensions } = worksheetExtensions(root, scopedChildren(root))
  if (!list) return xml
  const patches: XmlPatch[] = []
  for (const extension of extensions) {
    if (extensionUri(extension) !== X14_DV_EXT_URI.toUpperCase()) continue
    const sections = validationSections(extension).flatMap((section) => {
      const entries = scopedChildren(section).filter((child) =>
        isElement(child, 'dataValidation', X14_XMLNS),
      )
      let count = entries.length
      const changed = entries.flatMap((entry) => {
        const rewritten = rewriteX14ValidationEntry(entry, rewriteFormula, rewriteSqref)
        if (!rewritten) count -= 1
        return rewritten === entry.xml ? [] : [patchElement(entry, rewritten)]
      })
      if (changed.length === 0) return []
      const body = applyPatches(section.inner, changed)
      if (!body.trim()) return [patchElement(section, '')]
      const opening =
        count === entries.length
          ? section.opening
          : section.opening.replace(XML_ATTRIBUTE, (attribute, prefix: string, name: string) => {
              if (name !== 'count') return attribute
              const quote = attribute.at(-1)
              return `${prefix}${quote}${count}${quote}`
            })
      const markup = withBody(section, body)
      return [patchElement(section, opening + markup.slice(section.opening.length))]
    })
    if (sections.length === 0) continue
    const body = applyPatches(extension.inner, sections)
    patches.push(patchElement(extension, body.trim() ? withBody(extension, body) : ''))
  }
  if (patches.length === 0) return xml
  const body = applyPatches(list.inner, patches)
  const worksheet = applyPatches(root.inner, [
    patchElement(list, body.trim() ? withBody(list, body) : ''),
  ])
  return applyPatches(xml, [patchElement(root, withBody(root, worksheet))])
}

function rewriteX14ValidationEntry(
  entry: ScopedElement,
  rewriteFormula: (formula: string) => string,
  rewriteSqref: ((sqref: string) => string | null) | undefined,
): string {
  const fields = scopedChildren(entry)
  const patches: XmlPatch[] = []
  const sqref = fields.find((field) => isElement(field, 'sqref', XM_XMLNS))
  if (sqref && rewriteSqref) {
    const original = elementText(sqref.inner)
    const rewritten = rewriteSqref(original)
    if (!rewritten?.trim()) return ''
    if (rewritten !== original) {
      patches.push(patchElement(sqref, withBody(sqref, escapeXmlText(rewritten))))
    }
  }
  for (const field of fields) {
    if (
      field.namespace !== X14_XMLNS ||
      (field.local !== 'formula1' && field.local !== 'formula2')
    ) {
      continue
    }
    const formula = scopedChildren(field).find((child) => isElement(child, 'f', XM_XMLNS))
    if (!formula) continue
    const original = elementText(formula.inner)
    const rewritten = rewriteFormula(original)
    if (rewritten !== original) {
      const updated = patchElement(formula, withBody(formula, escapeXmlText(rewritten)))
      patches.push(patchElement(field, withBody(field, applyPatches(field.inner, [updated]))))
    }
  }
  return patches.length ? withBody(entry, applyPatches(entry.inner, patches)) : entry.xml
}

function rewriteExtendedValidations(
  root: ScopedElement,
  children: ScopedElement[],
  prepared: readonly PreparedRule[],
  replaced: ReadonlySet<string> | undefined,
): XmlPatch | undefined {
  const { list, extensions } = worksheetExtensions(root, children)
  const dvUri = X14_DV_EXT_URI.toUpperCase()
  const owner = extensions.find((extension) => extensionUri(extension) === dvUri)
  const target = new Map(owner?.namespaces ?? list?.namespaces ?? root.namespaces)
  target.set('x14', X14_XMLNS)
  target.set('xm', XM_XMLNS)
  // Older builds wrote the section under the CF extension. Move those
  // validations into the correct extension without altering its CF payload.
  const managed = extensions
    .filter((extension) => [dvUri, X14_CF_EXT_URI].includes(extensionUri(extension) ?? ''))
    .map((extension) => ({ extension, sections: validationSections(extension) }))
  const entries = [
    ...(replaced
      ? managed.flatMap(({ sections }) =>
          sections.flatMap((section) =>
            scopedChildren(section)
              .filter((entry) => isElement(entry, 'dataValidation', X14_XMLNS))
              .flatMap((entry) => {
                const sqref = scopedChildren(entry).find((child) =>
                  isElement(child, 'sqref', XM_XMLNS),
                )
                if (!sqref) return []
                const ref = elementText(sqref.inner)
                const remaining = remainingAreas(ref, replaced)
                if (!remaining) return []
                const markup =
                  remaining === ref
                    ? entry.xml
                    : withBody(
                        entry,
                        applyPatches(entry.inner, [
                          patchElement(sqref, withBody(sqref, escapeXmlText(remaining))),
                        ]),
                      )
                return [qualifyMovedEntry(entry, markup, target)]
              }),
          ),
        )
      : []),
    ...prepared.map(x14Entry),
  ]
  const block = entries.length
    ? '<x14:dataValidations xmlns:x14="' +
      X14_XMLNS +
      '" xmlns:xm="' +
      XM_XMLNS +
      '" count="' +
      entries.length +
      '">' +
      entries.join('') +
      '</x14:dataValidations>'
    : ''
  const patches = managed.flatMap(({ extension, sections }) => {
    if (sections.length === 0 && extension !== owner) return []
    const body =
      applyPatches(
        extension.inner,
        sections.map((section) => patchElement(section, '')),
      ) + (extension === owner ? block : '')
    return [patchElement(extension, body.trim() ? withBody(extension, body) : '')]
  })
  let appended = ''
  if (!owner && block) {
    const tag = prefixOf((list ?? root).name) + 'ext'
    appended =
      '<' +
      tag +
      ' uri="' +
      X14_DV_EXT_URI +
      '" xmlns:x14="' +
      X14_XMLNS +
      '">' +
      block +
      '</' +
      tag +
      '>'
  }
  if (patches.length === 0 && !appended) return undefined
  const inner = applyPatches(list?.inner ?? '', patches) + appended
  if (list) return patchElement(list, inner.trim() ? withBody(list, inner) : '')
  const tag = prefixOf(root.name) + 'extLst'
  return { start: root.inner.length, length: 0, xml: '<' + tag + '>' + inner + '</' + tag + '>' }
}

interface ReadValidationEntry {
  readonly attributes: Attributes
  readonly sqref: string
  readonly formulas: string[]
}

/// Reads the worksheet's own legacy and x14 rules using namespace URI and
/// direct parentage, so coincident local names in other extensions are ignored.
export function readWorksheetValidations(xml: string): ReadValidationEntry[] {
  if (!xml.includes('dataValidation')) return []
  const root = worksheetRoot(xml)
  if (!root) return []
  const children = scopedChildren(root)
  const { extensions } = worksheetExtensions(root, children)
  const legacy = children.filter((child) => isElement(child, 'dataValidations', root.namespace))
  const extended = extensions
    .filter((extension) => extensionUri(extension) === X14_DV_EXT_URI.toUpperCase())
    .flatMap(validationSections)
  return [
    ...legacy.map((section) => ({ section, x14: false })),
    ...extended.map((section) => ({ section, x14: true })),
  ].flatMap(({ section, x14 }) =>
    scopedChildren(section)
      .filter((entry) => isElement(entry, 'dataValidation', section.namespace))
      .map((entry) => {
        const fields = scopedChildren(entry)
        const sqref = x14
          ? (fields.find((field) => isElement(field, 'sqref', XM_XMLNS))?.inner ?? '')
          : (entry.attributes.get('sqref') ?? '')
        const formulas = ['formula1', 'formula2'].flatMap((name) => {
          const field = fields.find((child) => isElement(child, name, section.namespace))
          if (!field) return []
          if (!x14) return [elementText(field.inner)]
          const formula = scopedChildren(field).find((child) => isElement(child, 'f', XM_XMLNS))
          return formula ? [elementText(formula.inner)] : []
        })
        return { attributes: entry.attributes, sqref: x14 ? elementText(sqref) : sqref, formulas }
      }),
  )
}

function errorStyleName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const style = Number(value)
  if (!(style in DV_ERROR_STYLE_NAMES)) {
    throw new DvEditError(`Unsupported data-validation error style "${String(value)}".`)
  }
  return DV_ERROR_STYLE_NAMES[style]
}

/// Inverse of the install-side formula transforms: list literals regain their
/// quotes, `=`-prefixed references/formulas lose the prefix, and panel-edited
/// date/time strings become Excel serial numbers.
function formulaText(type: string | undefined, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const text = String(raw)
  if (text === '') return undefined
  if (type === 'list') {
    return text.startsWith('=') ? text.slice(1) : `"${text.replaceAll('"', '""')}"`
  }
  if (type === 'custom') {
    return text.startsWith('=') ? text.slice(1) : text
  }
  if (type === 'date') {
    const serial = dateToSerial(text)
    if (serial !== undefined) return String(serial)
  }
  if (type === 'time') {
    const fraction = timeToFraction(text)
    if (fraction !== undefined) return String(fraction)
  }
  return text.startsWith('=') ? text.slice(1) : text
}

/// 'YYYY-MM-DD[ HH:mm[:ss]]' (or slashes) → Excel serial (days since
/// 1899-12-30). Plain numbers and references pass through untouched.
/// Impossible calendar dates or clock times return undefined so the caller
/// keeps the original text instead of writing a silently wrong serial; a
/// pre-1900 year throws DvEditError, because it has no serial to write.
/// Serials 1-59 sit one day before the linear rule (Excel's phantom 1900-02-29);
/// formatSerial in @genoffice/file-parse reverses the same shift.
function dateToSerial(text: string): number | undefined {
  const match =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(
      text.trim(),
    )
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match
  const yearNum = Number(year)
  const monthNum = Number(month)
  const dayNum = Number(day)
  // Excel's 1900 date system has no serial before 1900-01-01, so such a date
  // cannot be written at all. Date.UTC also maps a 0..99 year onto 19xx
  // (0099 -> 1999), which would otherwise store a plausible, silently wrong
  // serial; reject the year outright instead.
  if (yearNum < 1900) {
    throw new DvEditError(
      `Data-validation date "${text.trim()}" is before 1900, which Excel cannot store.`,
    )
  }
  if (monthNum < 1 || monthNum > 12) return undefined
  if (dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)) return undefined
  let seconds = 0
  if (hour !== undefined) {
    const hourNum = Number(hour)
    const minuteNum = Number(minute)
    const secondNum = Number(second ?? 0)
    if (hourNum < 0 || hourNum > 23) return undefined
    if (minuteNum < 0 || minuteNum > 59) return undefined
    if (secondNum < 0 || secondNum > 59) return undefined
    seconds = hourNum * 3600 + minuteNum * 60 + secondNum
  }
  const days = (Date.UTC(yearNum, monthNum - 1, dayNum) - Date.UTC(1899, 11, 30)) / 86_400_000
  const serial = days < 61 ? days - 1 : days
  return seconds === 0 ? serial : serial + seconds / 86_400
}

/// Days in a 1-based month, with the Gregorian leap-year rule for February.
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

/// Gregorian leap-year rule: divisible by 4, except centuries not by 400.
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function timeToFraction(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text.trim())
  if (!match) return undefined
  const [, hour, minute, second] = match
  const hourNum = Number(hour)
  const minuteNum = Number(minute)
  const secondNum = Number(second ?? 0)
  if (hourNum < 0 || hourNum > 23) return undefined
  if (minuteNum < 0 || minuteNum > 59) return undefined
  if (secondNum < 0 || secondNum > 59) return undefined
  return (hourNum * 3600 + minuteNum * 60 + secondNum) / 86_400
}

function toRef(range: DvCellArea): string {
  if (
    range.startRow < 0 ||
    range.startColumn < 0 ||
    range.endRow < range.startRow ||
    range.endColumn < range.startColumn ||
    range.endRow >= MAX_GRID_ROWS ||
    range.endColumn >= MAX_GRID_COLUMNS
  ) {
    throw new DvEditError('A data-validation range lies outside the worksheet grid.')
  }
  const start = `${columnToLetters(range.startColumn)}${range.startRow + 1}`
  return range.startRow === range.endRow && range.startColumn === range.endColumn
    ? start
    : `${start}:${columnToLetters(range.endColumn)}${range.endRow + 1}`
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
