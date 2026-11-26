import { randomUUID } from 'node:crypto'
import { XMLValidator } from 'fast-xml-parser'
import { readWorkbookRedactionSource } from '../../../sheets/src/node/workbook-redactions'
import { parseSlicerState } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-slicer'
import { listWorkbookQueries } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-connections'
import { refreshableQueriesOf } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-connection-refresh'
import { parsePivotDefinition } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-pivot'
import { workbookPivotDefinitionSchema, workbookSaveRequestSchema } from '../../../sheets/src/shared/desktop-api'
import { mapWorkbookSaveRequest } from '../../../sheets/src/shared/workbook-save-plan'
import { createBufferEntrySource, type EntrySource } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway'
import { parseSheetElements, readAttribute, decodeAttribute, parseRelationships } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets'
import { resolveRelTarget } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add'
import { planWorkbookMutation } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-package-io'
import {readWorkbookExternalLinks} from './external-links.ts'
import type {WorkbookPackageQuery} from '../../worker/src/native/gateway.ts'

/** Bundled for the server; no Node gateway code enters the browser build. */
export async function planWorkbookSave(
  bytes: Buffer,
  sheets: readonly { id: string; name: string }[],
  input: unknown,
) {
  try {
    return await planSave(await createBufferEntrySource(bytes), sheets, input)
  } catch {
    throw Object.assign(new Error('Invalid workbook edits'), { statusCode: 400 })
  }
}

const ambiguousXml = (xml: string) => /<!--|<!\[CDATA\[|<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(xml)

function prepareWorksheetLiterals(xml: string, prefix: string, marker: RegExp, comments: string[]) {
  const text = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>/g, (literal, cdata: string | undefined) => {
    if (cdata !== undefined) return cdata.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    return `${prefix}${comments.push(literal) - 1}-->`
  })
  // Keep declarations and other ambiguous constructs outside literal text rejected.
  if (ambiguousXml(text.replace(marker, '')) || XMLValidator.validate(xml) !== true) {
    throw new Error('Ambiguous worksheet')
  }
  return text
}

/** Isolated-runner opt-in: derive the native sheet-<sheetId> mapping from the
 * exact entry source being planned. No browser mapping and no second ZIP load. */
export async function planFromWorkbook(bytes: Buffer, input: unknown) {
  try {
    const source = await createBufferEntrySource(bytes)
    const request = workbookSaveRequestSchema.parse(input)
    const editedSheets = new Set([...request.edits, ...request.formulaValues].map(edit => edit.sheetId))
    const workbook = await source.readText('xl/workbook.xml')
    // The existing text-based sheet planner cannot safely interpret these XML
    // constructs. Reject ambiguity instead of letting a comment forge a sheet.
    if (ambiguousXml(workbook)) throw new Error('Ambiguous workbook')
    const elements = parseSheetElements(workbook)
    // Fail closed on declarations outside the shared parser's supported
    // double-quoted, empty-element grammar, rather than silently omitting a
    // sheet or reading an attribute-shaped substring inside another value.
    if ([...workbook.matchAll(/<(?:[\w.-]+:)?sheet(?=[\s/>])/g)].length !== elements.length) throw new Error('Unsupported sheets')
    const relationshipsXml = await source.readText('xl/_rels/workbook.xml.rels')
    if (ambiguousXml(relationshipsXml)) throw new Error('Ambiguous relationships')
    const relationships = parseRelationships(relationshipsXml)
    const ids = new Set<string>(), names = new Set<string>()
    const worksheetPaths = new Set<string>()
    const preparedWorksheets = new Map<string, string>()
    const comments: string[] = []
    const prefix = `<!--dyoffice-${randomUUID()}-`
    const marker = new RegExp(`${prefix}(\\d+)-->`, 'g')
    if (elements.length < 1 || elements.length > 256) throw new Error('Invalid sheets')
    const sheets = []
    for (const element of elements) {
      if (!/^<sheet(?:\s+[A-Za-z_][\w.:-]*="[^"<]*")*\s*\/>$/.test(element.xml)) throw new Error('Unsupported sheet declaration')
      const attributes = [...element.xml.matchAll(/\s+([A-Za-z_][\w.:-]*)="([^"<]*)"/g)]
      if (new Set(attributes.map(match => match[1])).size !== attributes.length || attributes.some(match => readAttribute(element.xml, match[1]!) !== match[2])) throw new Error('Ambiguous sheet attributes')
      const rawId = readAttribute(element.xml, 'sheetId')
      if (!rawId || !element.relationshipId) throw new Error('Missing sheet identity')
      const id = `sheet-${decodeAttribute(rawId)}`, name = element.name
      if (id.length > 512 || !name.length || name.length > 255 || ids.has(id) || names.has(name)) throw new Error('Ambiguous sheets')
      const rels = relationships.filter(rel => rel.id === element.relationshipId)
      const rel = rels[0]
      if (rels.length !== 1 || !rel || rel.external || !rel.type.endsWith('/worksheet')) throw new Error('Invalid worksheet relationship')
      const path = resolveRelTarget('xl/workbook.xml', rel.target.replace(/^\/?xl\//, ''))
      if (worksheetPaths.has(path)) throw new Error('Ambiguous worksheet parts')
      if (!await source.has(path)) throw new Error('Missing worksheet')
      if (editedSheets.has(id)) {
        const xml = await source.readText(path)
        if (ambiguousXml(xml)) preparedWorksheets.set(path, prepareWorksheetLiterals(xml, prefix, marker, comments))
      }
      worksheetPaths.add(path)
      ids.add(id); names.add(name); sheets.push({ id, name })
    }
    if (!preparedWorksheets.size) return await planSave(source, sheets, request)
    const plan = await planSave({
      ...source,
      readText: async (path) => preparedWorksheets.get(path) ?? source.readText(path),
    }, sheets, request)
    const restoreComments = (entries: ReadonlyMap<string, string>) => new Map(
      [...entries].map(([path, text]) => [path, text.replace(marker, (original, index) => comments[Number(index)] ?? original)]),
    )
    return comments.length ? { ...plan, replaced: restoreComments(plan.replaced), added: restoreComments(plan.added) } : plan
  } catch {
    throw Object.assign(new Error('Invalid workbook edits'), { statusCode: 400 })
  }
}

async function planSave(source: EntrySource, sheets: readonly { id: string; name: string }[], input: unknown) {
  try {
    const request = workbookSaveRequestSchema.parse(input)
    // These desktop transports imply paths, dialogs, or process-local state.
    if (
      request.mode !== 'save' ||
      request.targetPath !== undefined ||
      request.overwrite !== undefined ||
      request.restoreWriteBack !== undefined ||
      request.defaultName !== undefined ||
      request.csvContent !== undefined ||
      request.editsTransferId !== undefined
    )
      throw new Error('Unsupported Web save transport')
    const mapping = mapWorkbookSaveRequest(
      new Map(sheets.map((sheet) => [sheet.id, sheet.name])),
      request,
    )
    return await planWorkbookMutation(source, {
      ...mapping,
      cfStates: mapping.cfStates?.map(state => ({ ...state, preserveUneditable: true })),
      filterStates: mapping.filterStates?.map(state => ({ ...state, preserveUneditable: true })),
    })
  } catch {
    throw Object.assign(new Error('Invalid workbook edits'), { statusCode: 400 })
  }
}

/** Read preserved package metadata using the same parsers as desktop. This
 * enumerates connections; it never fetches any linked workbook or URL. */
export async function readWorkbookPackage(bytes: Buffer, _signal?: AbortSignal, query?: WorkbookPackageQuery) {
  const source = await createBufferEntrySource(bytes)
  if (query && 'externalLinks' in query) {
    try { return await readWorkbookExternalLinks(source) }
    catch { throw Object.assign(new Error('Invalid external link metadata'), {statusCode:400}) }
  }
  const pivot=query
  if (pivot) {
    if (!/^xl\/pivotTables\/[A-Za-z0-9._-]+\.xml$/.test(pivot.path) || !/^xl\/pivotCache\/[A-Za-z0-9._-]+\.xml$/.test(pivot.cachePath)) throw Object.assign(new Error('Invalid pivot parts'), {statusCode:400})
    try {
      const [pivotXml,cacheXml] = await Promise.all([source.readText(pivot.path),source.readText(pivot.cachePath)])
      return workbookPivotDefinitionSchema.parse(parsePivotDefinition(pivotXml,cacheXml))
    } catch {
      throw Object.assign(new Error('Invalid pivot definition'), {statusCode:400})
    }
  }
  const names = new Set(await source.paths())
  const read = async (path: string) => names.has(path) ? source.readText(path) : undefined
  return {
    redactions: await readWorkbookRedactionSource(source),
    slicers: await parseSlicerState(source),
    connections: {connections: await refreshableQueriesOf(read)},
    queries: await listWorkbookQueries(read),
  }
}
