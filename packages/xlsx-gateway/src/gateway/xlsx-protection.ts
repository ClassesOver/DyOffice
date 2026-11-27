/// Worksheet protection: `<sheetProtection>` with Excel's permission flags
/// and password hash. Also: workbook structure protection
/// (`<workbookProtection>`) and allow-edit ranges (`<protectedRanges>`).
import type { SheetPasswordHash } from './xlsx-protection-hash.ts'
import { readRootOpening } from './xlsx-namespace.ts'
import { omitWorksheetTagAttributes, updateWorksheetTagAttribute, worksheetChildren } from './xlsx-structure.ts'
import { childElements } from './xlsx-style-entries.ts'
import { applyPatches, isElement, patchElement, prefixOf, scopedChildren, withBody, withNamespaces, type ScopedElement } from './xlsx-worksheet-xml.ts'

export class SheetProtectionError extends Error {}

export const SHEET_PROTECTION_PERMISSIONS = [
  'selectLockedCells',
  'selectUnlockedCells',
  'formatCells',
  'formatColumns',
  'formatRows',
  'insertColumns',
  'insertRows',
  'insertHyperlinks',
  'deleteColumns',
  'deleteRows',
  'sort',
  'autoFilter',
  'pivotTables',
  'objects',
  'scenarios',
] as const

export type SheetProtectionPermission = (typeof SHEET_PROTECTION_PERMISSIONS)[number]
export type SheetProtectionAllow = Record<SheetProtectionPermission, boolean>

/// Attributes whose absence means "allowed" (schema default 0 = unlocked);
/// every other permission attribute defaults to 1 = locked.
const DEFAULT_ALLOWED = new Set<SheetProtectionPermission>([
  'selectLockedCells',
  'selectUnlockedCells',
  'objects',
  'scenarios',
])

/// What Excel's Protect Sheet dialog pre-checks.
export const DEFAULT_SHEET_PROTECTION_ALLOW: SheetProtectionAllow = {
  selectLockedCells: true,
  selectUnlockedCells: true,
  formatCells: false,
  formatColumns: false,
  formatRows: false,
  insertColumns: false,
  insertRows: false,
  insertHyperlinks: false,
  deleteColumns: false,
  deleteRows: false,
  sort: false,
  autoFilter: false,
  pivotTables: false,
  objects: false,
  scenarios: false,
}

export interface SheetProtectionWrite {
  readonly protected: boolean
  /// Absent together with `password`: keep the file's own flags (legacy toggle).
  readonly allow?: SheetProtectionAllow | undefined
  readonly password?: SheetPasswordHash | null | undefined
  /// The caller checked the file's password; unprotecting may drop the hash.
  readonly verified?: boolean | undefined
}

export interface ParsedSheetProtection {
  readonly protected: boolean
  readonly allow: SheetProtectionAllow
  readonly password: SheetPasswordHash | null
}

function isTrue(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

export function parseSheetProtectionElement(element: string): ParsedSheetProtection {
  const [node] = childElements(element)
  const attributes = node && withNamespaces(node, new Map()).attributes
  return parseSheetProtectionAttributes((name) => attributes?.get(name))
}

function protectionChildren(xml: string, rootName = readRootOpening(xml)?.name ?? ''): ScopedElement[] {
  if (rootName.slice(prefixOf(rootName).length) === 'worksheet') return worksheetChildren(xml)
  // The gateway also accepts worksheet fragments without a root wrapper.
  return childElements(xml).map((child) => withNamespaces(child, new Map()))
    .filter((child) => child.namespace === '')
}

function insertProtectionPart(xml: string, children: readonly ScopedElement[], element: string, afterProtection = false): string {
  const data = children.find((child) => child.local === 'sheetData')
  if (!data) throw new SheetProtectionError('Worksheet has no sheetData element.')
  const anchor = (afterProtection ? children.find((child) => child.local === 'sheetProtection') : undefined)
    ?? children.find((child) => child.local === 'sheetCalcPr') ?? data
  const at = anchor.start + anchor.xml.length
  return xml.slice(0, at) + element + xml.slice(at)
}

function hasPassword(element: ScopedElement): boolean {
  return element.attributes.has('password') || element.attributes.has('hashValue')
}

export function parseSheetProtectionAttributes(
  attribute: (name: string) => string | undefined,
): ParsedSheetProtection {
  const allow = { ...DEFAULT_SHEET_PROTECTION_ALLOW }
  for (const permission of SHEET_PROTECTION_PERMISSIONS) {
    const value = attribute(permission)
    allow[permission] = DEFAULT_ALLOWED.has(permission)
      ? !isTrue(value)
      : value === '0' || value === 'false'
  }
  const hashValue = attribute('hashValue')
  const legacy = attribute('password')
  const password: SheetPasswordHash | null = hashValue
    ? {
        algorithmName: attribute('algorithmName') ?? 'SHA-512',
        hashValue,
        saltValue: attribute('saltValue') ?? '',
        spinCount: Number(attribute('spinCount') ?? '0') || 0,
      }
    : legacy
      ? { legacy }
      : null
  return { protected: isTrue(attribute('sheet')), allow, password }
}

/// Worksheet-level parse: null when the sheet has no `<sheetProtection>`.
export function readSheetProtection(worksheetXml: string): ParsedSheetProtection | null {
  const existing = protectionChildren(worksheetXml).find((child) => child.local === 'sheetProtection')
  return existing ? parseSheetProtectionAttributes((name) => existing.attributes.get(name)) : null
}

function escapeAttrValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/// Schema attribute order; lock-style flags are written only when they
/// differ from their default, matching Excel's own output.
export function sheetProtectionElement(
  allow: SheetProtectionAllow,
  password: SheetPasswordHash | null,
): string {
  const attributes: string[] = []
  if (password && 'legacy' in password) attributes.push(`password="${password.legacy}"`)
  else if (password) {
    attributes.push(
      `algorithmName="${escapeAttrValue(password.algorithmName)}"`,
      `hashValue="${escapeAttrValue(password.hashValue)}"`,
      `saltValue="${escapeAttrValue(password.saltValue)}"`,
      `spinCount="${password.spinCount}"`,
    )
  }
  attributes.push('sheet="1"')
  const order: readonly SheetProtectionPermission[] = [
    'objects',
    'scenarios',
    'formatCells',
    'formatColumns',
    'formatRows',
    'insertColumns',
    'insertRows',
    'insertHyperlinks',
    'deleteColumns',
    'deleteRows',
    'selectLockedCells',
    'sort',
    'autoFilter',
    'pivotTables',
    'selectUnlockedCells',
  ]
  for (const permission of order) {
    if (DEFAULT_ALLOWED.has(permission)) {
      if (!allow[permission]) attributes.push(`${permission}="1"`)
    } else if (allow[permission]) {
      attributes.push(`${permission}="0"`)
    }
  }
  return `<sheetProtection ${attributes.join(' ')}/>`
}

export function applySheetProtection(
  worksheetXml: string,
  state: boolean | SheetProtectionWrite,
): string {
  const write: SheetProtectionWrite = typeof state === 'boolean' ? { protected: state } : state
  const rootName = readRootOpening(worksheetXml)?.name ?? ''
  const children = protectionChildren(worksheetXml, rootName)
  const existing = children.find((child) => child.local === 'sheetProtection')
  if (!write.protected) {
    if (!existing) return worksheetXml
    if (!write.verified && hasPassword(existing)) {
      throw new SheetProtectionError(
        'This sheet is protected with a password — removing its protection is not ' + 'supported.',
      )
    }
    return applyPatches(worksheetXml, [patchElement(existing, '')])
  }
  const element =
    write.allow === undefined && write.password === undefined
      ? null
      : sheetProtectionElement(
          write.allow ?? DEFAULT_SHEET_PROTECTION_ALLOW,
          write.password ?? null,
        )
  if (existing) {
    if (element) {
      const managed = ['sheet', 'password', 'algorithmName', 'hashValue', 'saltValue', 'spinCount',
        ...SHEET_PROTECTION_PERMISSIONS]
      const kept = omitWorksheetTagAttributes(existing.opening, managed)
      const attrs = element.slice('<sheetProtection'.length, -2)
      const opening = kept.replace(/(\s*\/?>)$/, (_end, suffix) => attrs + suffix)
      const replacement = opening + existing.xml.slice(existing.opening.length)
      return applyPatches(worksheetXml, [patchElement(existing, replacement)])
    }
    if (isTrue(existing.attributes.get('sheet'))) return worksheetXml
    const updated = updateWorksheetTagAttribute(existing.opening, 'sheet', '1') +
      existing.xml.slice(existing.opening.length)
    return applyPatches(worksheetXml, [patchElement(existing, updated)])
  }
  const qualifier = prefixOf(rootName)
  const replacement = (element ?? '<sheetProtection sheet="1" objects="1" scenarios="1"/>')
    .replace('<sheetProtection', `<${qualifier}sheetProtection`)
  return insertProtectionPart(worksheetXml, children, replacement)
}

const WORKBOOK_PROTECTION_PATTERN =
  /<workbookProtection\b[^>]*\/>|<workbookProtection\b[^>]*>\s*<\/workbookProtection>/

/// Workbook structure lock in workbook.xml. Unlocking a password-protected
/// structure fails closed; other workbookProtection attributes stay verbatim.
export function applyWorkbookProtection(workbookXml: string, lockStructure: boolean): string {
  const existing = WORKBOOK_PROTECTION_PATTERN.exec(workbookXml)
  if (!lockStructure) {
    if (!existing) return workbookXml
    if (/\bworkbook(?:Password|HashValue)="/.test(existing[0])) {
      throw new SheetProtectionError(
        'The workbook structure is protected with a password — removing its protection ' +
          'is not supported.',
      )
    }
    const stripped = existing[0].replace(/\s+lockStructure="[^"]*"/, '')
    // Drop the element entirely once no protection attribute remains.
    const empty = /^<workbookProtection\s*(?:\/>|>\s*<\/workbookProtection>)$/.test(stripped)
    return (
      workbookXml.slice(0, existing.index) +
      (empty ? '' : stripped) +
      workbookXml.slice(existing.index + existing[0].length)
    )
  }
  if (existing) {
    if (/\blockStructure="(?:1|true)"/.test(existing[0])) return workbookXml
    const updated = /\slockStructure="/.test(existing[0])
      ? existing[0].replace(/(\s+lockStructure=)"[^"]*"/, '$1"1"')
      : existing[0].replace(/<workbookProtection\b/, '<workbookProtection lockStructure="1"')
    return (
      workbookXml.slice(0, existing.index) +
      updated +
      workbookXml.slice(existing.index + existing[0].length)
    )
  }
  // Schema order: workbookProtection follows fileVersion/fileSharing/
  // workbookPr/alternateContent and precedes bookViews/sheets.
  const element = '<workbookProtection lockStructure="1"/>'
  const anchor = /<bookViews\b|<sheets\b/.exec(workbookXml)
  if (!anchor) throw new SheetProtectionError('Workbook has no sheets element.')
  return workbookXml.slice(0, anchor.index) + element + workbookXml.slice(anchor.index)
}

export interface ProtectedRangeState {
  readonly name: string
  readonly sqref: string
  /// Optional per-range password (Excel's own legacy/spi hash), already hashed
  /// by the caller via hashSheetPassword. Files whose existing ranges carry a
  /// password still fail closed below — the read side does not return hashes,
  /// so a rewrite cannot preserve them.
  readonly password?: SheetPasswordHash | null | undefined
}

export function protectedRangeHasCredentials(range: ScopedElement): boolean {
  return hasPassword(range) ||
    [...range.attributes.keys()].some((name) => name.slice(prefixOf(name).length) === 'securityDescriptor') ||
    scopedChildren(range).some((child) => child.local === 'securityDescriptor')
}

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/// Replaces the sheet's allow-edit ranges with the session's snapshot; an
/// empty set removes the element. Replacing password-protected ranges fails
/// closed (their hashes cannot be preserved through the rewrite).
export function applyProtectedRanges(
  worksheetXml: string,
  ranges: readonly ProtectedRangeState[],
): string {
  const rootName = readRootOpening(worksheetXml)?.name ?? ''
  const children = protectionChildren(worksheetXml, rootName)
  const existing = children.find((child) => child.local === 'protectedRanges')
  const stored = existing
    ? scopedChildren(existing).filter((child) => isElement(child, 'protectedRange', existing.namespace))
    : []
  if (stored.some(protectedRangeHasCredentials)) {
    throw new SheetProtectionError(
      'This sheet has password- or permission-protected edit ranges — editing them is not ' +
        'supported.',
    )
  }
  const qualifier = prefixOf(existing?.name ?? rootName)
  const body = ranges
    .map((range) => {
      const passwordAttrs = range.password
        ? 'legacy' in range.password
          ? ` password="${range.password.legacy}"`
          : ` algorithmName="${escapeAttr(range.password.algorithmName)}" hashValue="${escapeAttr(range.password.hashValue)}" saltValue="${escapeAttr(range.password.saltValue)}" spinCount="${range.password.spinCount}"`
        : ''
      return `<${qualifier}protectedRange sqref="${escapeAttr(range.sqref)}" name="${escapeAttr(range.name)}"${passwordAttrs}/>`
    })
    .join('')
  if (!existing) {
    return body === '' ? worksheetXml : insertProtectionPart(
      worksheetXml, children, `<${qualifier}protectedRanges>${body}</${qualifier}protectedRanges>`, true,
    )
  }
  let retained = existing.inner
  for (const range of stored.reverse()) {
    retained = retained.slice(0, range.start) + retained.slice(range.start + range.xml.length)
  }
  const replacement = (body + retained).trim() ? withBody(existing, body + retained) : ''
  return applyPatches(worksheetXml, [patchElement(existing, replacement)])
}
