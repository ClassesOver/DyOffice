import { XMLParser } from 'fast-xml-parser'
import type JSZip from 'jszip'
import {
  relsPathFor,
  resolveRelTarget,
} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add.ts'
import { decodeAttribute } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets.ts'
import {
  MAX_GRID_COLUMNS,
  MAX_GRID_ROWS,
} from '../../../../packages/xlsx-gateway/src/shared/grid-bounds.ts'
import { visualMediaType } from './xlsx-node-visuals.ts'

type ZipText = (path: string) => Promise<string>
type Xml = { [name: string]: Xml | Xml[] | string | undefined }
type XmlNode = Xml | Xml[] | string | undefined
type CellImage = { row: number; column: number; mediaPath: string }

const workbookPath = 'xl/workbook.xml'
const wpsPart = 'xl/cellimages.xml'
const richValueType = 'XLRICHVALUE'
const maxCellImages = 500
const maxMediaBytes = 20 * 1024 * 1024

const partXml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  trimValues: false,
  cdataPropName: '#cdata',
})
const sheetXml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  trimValues: false,
  cdataPropName: '#cdata',
  stopNodes: ['worksheet.sheetData.row.c.is', 'worksheet.sheetData.row.c.v', 'worksheet.extLst'],
})

const element = (node: XmlNode, name: string) =>
  node && typeof node === 'object' && !Array.isArray(node) ? node[name] : undefined
const list = (node: XmlNode): XmlNode[] =>
  node === undefined ? [] : Array.isArray(node) ? node : [node]
function text(node: XmlNode): string | undefined {
  if (typeof node === 'string') return decodeAttribute(node)
  const body = element(node, '#text')
  const cdata = element(node, '#cdata')
  return typeof cdata === 'string'
    ? cdata
    : typeof body === 'string'
      ? decodeAttribute(body)
      : undefined
}
const attr = (node: XmlNode, name: string) => text(element(node, `@_${name}`))
function index(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

async function readPart(read: ZipText, path: string, root: string): Promise<XmlNode> {
  try {
    const xml = await read(path)
    return xml ? element(partXml.parse(xml, true), root) : undefined
  } catch {
    // Missing or damaged optional image metadata leaves cached cells visible.
    return undefined
  }
}

async function relationships(read: ZipText, part: string): Promise<XmlNode[]> {
  return list(element(await readPart(read, relsPathFor(part), 'Relationships'), 'Relationship'))
}

function relatedPath(part: string, relation: XmlNode, kind: string): string | undefined {
  const target = attr(relation, 'Target')
  if (
    !target ||
    attr(relation, 'TargetMode') === 'External' ||
    !attr(relation, 'Type')?.endsWith(`/${kind}`)
  )
    return undefined
  try {
    return resolveRelTarget(part, target)
  } catch {
    return undefined
  }
}

async function imageTargets(read: ZipText, part: string, hasPart: (path: string) => boolean) {
  const targets = new Map<string, string>()
  for (const rel of await relationships(read, part)) {
    const id = attr(rel, 'Id')
    const path = relatedPath(part, rel, 'image')
    if (id && path && visualMediaType(path) && hasPart(path)) targets.set(id, path)
  }
  return targets
}

async function excelImages(read: ZipText, hasPart: (path: string) => boolean) {
  const result = new Map<number, string>()
  const rels = await relationships(read, workbookPath)
  const findPart = (kind: string) =>
    rels.map((rel) => relatedPath(workbookPath, rel, kind)).find((path) => path !== undefined)
  const metadataPath = findPart('sheetMetadata')
  const structuresPath = findPart('rdRichValueStructure')
  const valuesPath = findPart('rdRichValue')
  const imageRelsPath = findPart('richValueRel')
  if (!metadataPath || !structuresPath || !valuesPath || !imageRelsPath) return result
  const [metadata, structures, richValues, relsList, targets] = await Promise.all([
    readPart(read, metadataPath, 'metadata'),
    readPart(read, structuresPath, 'rvStructures'),
    readPart(read, valuesPath, 'rvData'),
    readPart(read, imageRelsPath, 'richValueRels'),
    imageTargets(read, imageRelsPath, hasPart),
  ])
  if (!targets.size) return result
  const localImageKeys = list(element(structures, 's')).map((structure) =>
    attr(structure, 't') === '_localImage'
      ? list(element(structure, 'k')).findIndex(
          (key) => attr(key, 'n') === '_rvRel:LocalImageIdentifier',
        )
      : -1,
  )
  const imagePaths = list(element(relsList, 'rel')).map((rel) => targets.get(attr(rel, 'id') ?? ''))
  const mediaByValue = list(element(richValues, 'rv')).map((record) => {
    const key = localImageKeys[index(attr(record, 's')) ?? -1]
    if (key === undefined || key < 0) return undefined
    const relIndex = index(text(list(element(record, 'v'))[key])?.trim())
    return relIndex === undefined ? undefined : imagePaths[relIndex]
  })
  const types = list(element(element(metadata, 'metadataTypes'), 'metadataType')).map((node) =>
    attr(node, 'name'),
  )
  const future = list(element(metadata, 'futureMetadata')).find(
    (node) => attr(node, 'name') === richValueType,
  )
  const indexes = list(element(future, 'bk')).map((record) => {
    const extensions = list(element(element(record, 'extLst'), 'ext'))
    const value = extensions
      .map((extension) => element(extension, 'rvb'))
      .find((node) => node !== undefined)
    return index(attr(value, 'i'))
  })
  for (const [position, record] of list(
    element(element(metadata, 'valueMetadata'), 'bk'),
  ).entries()) {
    const rc = list(element(record, 'rc')).find(
      (node) => types[(index(attr(node, 't')) ?? 0) - 1] === richValueType,
    )
    const futureIndex = index(attr(rc, 'v'))
    if (futureIndex === undefined) continue
    const path = mediaByValue[indexes[futureIndex] ?? futureIndex]
    if (path) result.set(position + 1, path)
  }
  return result
}

async function wpsImages(read: ZipText, hasPart: (path: string) => boolean) {
  const result = new Map<string, string>()
  if (!hasPart(wpsPart)) return result
  const [root, targets] = await Promise.all([
    readPart(read, wpsPart, 'cellImages'),
    imageTargets(read, wpsPart, hasPart),
  ])
  for (const entry of list(element(root, 'cellImage'))) {
    const picture = element(entry, 'pic')
    const name = attr(element(element(picture, 'nvPicPr'), 'cNvPr'), 'name')
    const path = targets.get(attr(element(element(picture, 'blipFill'), 'blip'), 'embed') ?? '')
    if (name && path) result.set(name, path)
  }
  return result
}

export async function readCellImageSources(read: ZipText, hasPart: (path: string) => boolean) {
  const [byIndex, byName] = await Promise.all([
    excelImages(read, hasPart),
    wpsImages(read, hasPart),
  ])
  return { byIndex, byName }
}

export const cellImageKey = (row: number, column: number) => row * MAX_GRID_COLUMNS + column

function explicitCell(address: string | undefined) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address ?? '')
  if (!match) return undefined
  let column = 0
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64
  return { row: Number(match[2]) - 1, column: column - 1 }
}

export function readSheetCellImages(
  xml: string,
  { byIndex, byName }: Awaited<ReturnType<typeof readCellImageSources>>,
) {
  const result = new Map<number, CellImage>()
  if ((!byIndex.size || !xml.includes('vm')) && (!byName.size || !/DISPIMG/i.test(xml)))
    return result
  let rows: XmlNode[]
  try {
    const worksheet = element(sheetXml.parse(xml), 'worksheet')
    rows = list(element(element(worksheet, 'sheetData'), 'row'))
  } catch {
    return result
  }
  let row = -1
  for (const rowNode of rows) {
    const explicitRow = index(attr(rowNode, 'r'))
    row = explicitRow ? explicitRow - 1 : row + 1
    let nextColumn = 0
    for (const cell of list(element(rowNode, 'c'))) {
      const position = explicitCell(attr(cell, 'r')) ?? { row, column: nextColumn }
      nextColumn = position.column + 1
      if (position.row >= MAX_GRID_ROWS || position.column >= MAX_GRID_COLUMNS) continue
      const vm = index(attr(cell, 'vm'))
      let mediaPath = vm === undefined ? undefined : byIndex.get(vm)
      if (!mediaPath && byName.size) {
        const formula = text(element(cell, 'f'))
        const name = /^\s*=*\s*(?:_xlfn\.)?DISPIMG\s*\(\s*"((?:""|[^"])*)"\s*,[\s\S]*\)\s*$/i.exec(
          formula ?? '',
        )?.[1]
        if (name) mediaPath = byName.get(name.replaceAll('""', '"'))
      }
      if (mediaPath) {
        result.set(cellImageKey(position.row, position.column), { ...position, mediaPath })
        if (result.size === maxCellImages) return result
      }
    }
  }
  return result
}

export async function readWorkbookImage(file: JSZip.JSZipObject, mediaType: string) {
  const stream = file.nodeStream('nodebuffer')
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    stream
      .on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxMediaBytes) {
          stream.pause()
          reject(new Error('MEDIA_LIMIT'))
        } else chunks.push(chunk)
      })
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks, size)))
      .resume()
  })
  if (!bytes.length) throw new Error('MEDIA_NOT_FOUND')
  return { mediaType, base64: bytes.toString('base64') }
}
