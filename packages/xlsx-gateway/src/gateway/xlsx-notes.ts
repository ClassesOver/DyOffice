/// Legacy-comment (note) writer: replaces a worksheet's full comment set —
/// the comments part, the note shapes of the VML drawing Excel needs to show
/// them, the worksheet rels, the `<legacyDrawing>` element, and the
/// [Content_Types].xml entries. Non-note VML shapes (checkboxes, buttons)
/// survive a rewrite untouched.

import { MAX_GRID_COLUMNS, MAX_GRID_ROWS } from '../shared/grid-bounds.ts'
import {
  allocatePartPath,
  appendRelationship,
  registerContentTypeDefault,
  registerContentTypeOverride,
  relativeTarget,
  relsPathFor,
  resolveRelTarget,
} from './xlsx-drawing-add.ts'
import { decodeXmlText, encodeXlsxEscapes } from './xlsx-escapes.ts'
import { ensureRelationshipNamespace, relationshipNamespaceOverride } from './xlsx-namespace.ts'
import { appendRelationshipRecord, nextFreeRelationshipId, removePartOverride } from './xlsx-sheets.ts'
import { childElements } from './xlsx-style-entries.ts'
import { shiftCellArea, StructuralShiftError, type StructuralOp } from './xlsx-structure.ts'
import { parseRef } from './xlsx-table-add.ts'
import {
  parseLegacyComments,
  syncThreadedComments,
  THREADED_COMMENTS_REL_TYPE,
  THREADED_NS,
  type LegacyCommentEntry,
  type SheetThread,
} from './xlsx-threaded-comments.ts'
import {
  applyPatches,
  isElement,
  patchElement,
  scopedChildren,
  withBody as replaceElementBody,
  withNamespaces,
  worksheetRoot,
  XML_ATTRIBUTE,
  type ScopedElement,
} from './xlsx-worksheet-xml.ts'

export type { SheetThread, SheetThreadReply } from './xlsx-threaded-comments.ts'

export class NoteEditError extends Error {}

/**
 * A picture painted onto a note.
 *
 * Excel shows a picture in a note by painting it onto the note's shape as a
 * picture fill, so the bytes live in `xl/media` and the note's shape reaches
 * them through the VML part's own relationships.
 */
export interface NotePicture {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif'
  readonly base64: string
  /**
   * The picture's pixel size. The shape is given the picture's own
   * proportions: a fill is stretched to the shape's frame, so a shape the size
   * of the text box would squash the photograph into it.
   */
  readonly widthPx: number
  readonly heightPx: number
  /// The file name, carried into the picture's title.
  readonly name?: string | undefined
}

export interface SheetNote {
  readonly row: number
  readonly column: number
  readonly author: string
  readonly text: string
  /// Threaded comment metadata (text is the root text); `null` turns a
  /// threaded cell back into a plain note.
  readonly thread?: SheetThread | null | undefined
  /**
   * The picture this note shows.
   *
   * `undefined` says nothing about the picture: whatever the note was already
   * carrying is kept. `null` takes the picture away.
   */
  readonly picture?: NotePicture | null | undefined
}

interface MutableNotePackage {
  paths(): Promise<readonly string[]>
  has(path: string): Promise<boolean>
  readText(path: string): Promise<string>
  write(path: string, content: string): void
  add(path: string, content: string): void
  addBinary(path: string, bytes: Uint8Array): void
  remove(path: string): void
  removedPaths?(): readonly string[]
}

const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const STRICT_OFFICE_REL_NS = 'http://purl.oclc.org/ooxml/officeDocument/relationships'
const COMMENTS_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const VML_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing'
const COMMENTS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml'
const CONTENT_TYPES_PATH = '[Content_Types].xml'
const VML_NS = 'urn:schemas-microsoft-com:vml'
const VML_EXCEL_NS = 'urn:schemas-microsoft-com:office:excel'
const VML_OFFICE_NS = 'urn:schemas-microsoft-com:office:office'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function columnName(index: number): string {
  let label = ''
  for (let i = index; i >= 0; i = Math.floor(i / 26) - 1) {
    label = String.fromCharCode(65 + (i % 26)) + label
  }
  return label
}

interface XmlBlock {
  readonly start: number
  readonly end: number
  readonly name: string
  readonly open: string
  readonly body: string
  readonly close: string
}

/** Locate the editable elements without rewriting surrounding XML or namespace bindings. */
function xmlBlocks(xml: string, name: string): XmlBlock[] {
  const tags = new RegExp(
    `<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<\\?[\\s\\S]*?\\?>|<(/?)((?:[\\w.-]+:)?${name})(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`,
    'g',
  )
  const blocks: XmlBlock[] = []
  const openings: Pick<XmlBlock, 'start' | 'name' | 'open'>[] = []
  for (const match of xml.matchAll(tags)) {
    const [tag, closing, qualified] = match
    if (!qualified) continue
    const index = match.index!
    const end = index + tag.length
    if (closing) {
      const opening = openings.pop()
      if (opening?.name === qualified) {
        blocks.push({ ...opening, end, body: xml.slice(opening.start + opening.open.length, index), close: tag })
      }
    } else if (tag.endsWith('/>')) {
      blocks.push({ start: index, end, name: qualified, open: tag, body: '', close: '' })
    } else {
      openings.push({ start: index, name: qualified, open: tag })
    }
  }
  return blocks.sort((a, b) => a.start - b.start)
}

function attribute(tag: string, name: string): string | undefined {
  for (const match of tag.matchAll(/\s+([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (match[1] === name) return decodeXmlText((match[2] ?? match[3])!)
  }
  return undefined
}

function replaceBlocks(xml: string, blocks: readonly XmlBlock[], replace: (block: XmlBlock) => string): string {
  let at = 0
  const parts: string[] = []
  for (const block of blocks) {
    if (block.start < at) continue
    parts.push(xml.slice(at, block.start), replace(block))
    at = block.end
  }
  parts.push(xml.slice(at))
  return parts.join('')
}

function rawBlock(block: XmlBlock): string {
  return block.open + block.body + block.close
}

function withBody(block: XmlBlock, body: string): string {
  return block.close
    ? block.open + body + block.close
    : block.open.slice(0, -2) + '>' + body + `</${block.name}>`
}

function prefixOf(block: XmlBlock): string {
  return block.name.slice(0, block.name.indexOf(':') + 1)
}

function noteRelationship(xml: string, type: string, id?: string) {
  const strictType = type.replace(OFFICE_REL_NS, STRICT_OFFICE_REL_NS)
  return xmlBlocks(xml, 'Relationship').find((block) => {
    const foundType = attribute(block.open, 'Type')
    return (
      (foundType === type || foundType === strictType) &&
      attribute(block.open, 'TargetMode') !== 'External' &&
      (id === undefined || attribute(block.open, 'Id') === id)
    )
  })
}

function relTarget(relsXml: string, type: string, id?: string): string | null {
  const found = noteRelationship(relsXml, type, id)
  return found ? attribute(found.open, 'Target') ?? null : null
}

function legacyDrawing(worksheetXml: string): ScopedElement | undefined {
  if (!worksheetXml.includes('legacyDrawing')) return undefined
  const root = worksheetRoot(worksheetXml)
  if (!root) return undefined
  const drawing = scopedChildren(root).find((child) =>
    isElement(child, 'legacyDrawing', root.namespace),
  )
  return drawing && { ...drawing, start: root.start + root.opening.length + drawing.start }
}

function legacyDrawingId(drawing: ScopedElement | undefined): string | undefined {
  if (!drawing) return undefined
  for (const [prefix, namespace] of drawing.namespaces) {
    if (prefix && (namespace === OFFICE_REL_NS || namespace === STRICT_OFFICE_REL_NS)) {
      const id = drawing.attributes.get(`${prefix}:id`)
      if (id !== undefined) return id
    }
  }
  return undefined
}

async function nextFreePath(
  pkg: MutableNotePackage,
  template: (index: number) => string,
): Promise<string> {
  const removed = new Set(pkg.removedPaths?.())
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = template(index)
    if (!removed.has(candidate) && !(await pkg.has(candidate))) return candidate
  }
  throw new NoteEditError('No free part name for the comments part.')
}

type NoteCell = Pick<SheetNote, 'row' | 'column'>

function cellRef(note: NoteCell): string {
  return `${columnName(note.column)}${note.row + 1}`
}

function noteXml(prefix: string, ref: string, authorId: number, text: string): string {
  return (
    `<${prefix}comment ref="${ref}" authorId="${authorId}">` +
    `<${prefix}text><${prefix}t xml:space="preserve">${escapeXml(encodeXlsxEscapes(text))}</${prefix}t></${prefix}text></${prefix}comment>`
  )
}

function buildCommentsXml(
  notes: readonly SheetNote[],
  overrides: ReadonlyMap<string, LegacyCommentEntry>,
): string {
  const authors: string[] = []
  const authorId = (author: string): number => {
    const existing = authors.indexOf(author)
    if (existing !== -1) return existing
    authors.push(author)
    return authors.length - 1
  }
  const comments = notes
    .map((note) => {
      const ref = cellRef(note)
      const entry = overrides.get(ref) ?? note
      return noteXml('', ref, authorId(entry.author), entry.text)
    })
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<authors>${authors.map((author) => `<author>${escapeXml(encodeXlsxEscapes(author))}</author>`).join('')}</authors>` +
    `<commentList>${comments}</commentList></comments>`
  )
}

function patchCommentsXml(
  xml: string,
  notes: readonly SheetNote[],
  overrides: ReadonlyMap<string, LegacyCommentEntry>,
  existingLegacy: ReadonlyMap<string, LegacyCommentEntry>,
): string {
  const authors = xmlBlocks(xml, 'authors')[0]
  const list = xmlBlocks(xml, 'commentList')[0]
  if (!authors || !list) {
    if (existingLegacy.size === 0) return buildCommentsXml(notes, overrides)
    throw new NoteEditError('The existing notes part cannot be edited without losing note data.')
  }
  const authorBlocks = xmlBlocks(authors.body, 'author')
  const commentBlocks = xmlBlocks(list.body, 'comment')
  const authorIds = new Map<string, number>()
  const recordedAuthorId = (block: XmlBlock): number | undefined => {
    const raw = attribute(block.open, 'authorId')
    const id = Number(raw)
    return raw !== undefined && /^\d+$/.test(raw) && id < authorBlocks.length ? id : undefined
  }
  for (const block of commentBlocks) {
    const id = recordedAuthorId(block)
    const ref = attribute(block.open, 'ref')
    const entry = ref === undefined ? undefined : existingLegacy.get(ref)
    if (id !== undefined && entry) authorIds.set(entry.author, id)
  }
  const appendedAuthors: string[] = []
  const usedAuthors = new Set<number>()
  const authorPrefix = prefixOf(authors)
  const commentPrefix = prefixOf(list)
  const entryXml = (ref: string, { author, text }: LegacyCommentEntry) => {
    let id = authorIds.get(author)
    if (id === undefined) {
      id = authorBlocks.length + appendedAuthors.length
      authorIds.set(author, id)
      appendedAuthors.push(
        `<${authorPrefix}author>${escapeXml(encodeXlsxEscapes(author))}</${authorPrefix}author>`,
      )
    }
    usedAuthors.add(id)
    return noteXml(commentPrefix, ref, id, text)
  }
  const pending = new Map(notes.map(note => [cellRef(note), note]))
  const commentBody = replaceBlocks(list.body, commentBlocks, (block) => {
    const originalRef = attribute(block.open, 'ref')
    const ref = originalRef?.split(':', 1)[0]?.replaceAll('$', '').toUpperCase()
    const note = ref === undefined ? undefined : pending.get(ref)
    if (ref === undefined || !note) return ''
    pending.delete(ref)
    const entry = overrides.get(ref) ?? note
    const original = existingLegacy.get(originalRef!)
    const id = recordedAuthorId(block)
    if (id !== undefined && original?.author === entry.author && original.text === entry.text) {
      usedAuthors.add(id)
      return rawBlock(block)
    }
    return entryXml(ref, entry)
  })
  const added = [...pending].map(([ref, note]) => entryXml(ref, overrides.get(ref) ?? note))
  const authorSlots = new Map(authorBlocks.map((block, index) => [block, index]))
  const authorBody = replaceBlocks(authors.body, authorBlocks, block =>
    usedAuthors.has(authorSlots.get(block)!) ? rawBlock(block) : `<${block.name}/>`,
  )
  return replaceBlocks(xml, [authors, list].sort((a, b) => a.start - b.start), block =>
    block === authors
      ? withBody(authors, authorBody + appendedAuthors.join(''))
      : withBody(list, commentBody + added.join('')),
  )
}

const VML_HEADER =
  '<xml xmlns:v="urn:schemas-microsoft-com:vml"' +
  ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
  ' xmlns:x="urn:schemas-microsoft-com:office:excel">' +
  '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>' +
  '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202"' +
  ' path="m,l,21600r21600,l21600,xe">' +
  '<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/>' +
  '</v:shapetype>'

const FIRST_NOTE_SHAPE_ID = 1025

function nextShapeId(vmlXml: string): number {
  let next = FIRST_NOTE_SHAPE_ID
  for (const match of vmlXml.matchAll(/\bid\s*=\s*(["'])_x0000_s(\d+)\1/g)) {
    const id = Number(match[2])
    if (id >= next) next = id + 1
  }
  return next
}

/// A note's picture, as the shape paints it: the fill element that reaches
/// the media, and the size the shape has to be given for the picture to keep
/// its proportions. The two travel together — a fill without the size would
/// stretch the photograph into the text box's frame.
interface NoteShapePicture {
  readonly fill: string
  readonly width?: string | undefined
  readonly height?: string | undefined
}

function noteImageKey(note: SheetNote): string {
  return `${note.column}:${note.row}`
}

const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const IMAGE_EXTENSIONS: Record<NotePicture['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
}

/// Excel's own ceiling for a note's shape. A photograph larger than that is
/// scaled down — proportionally, so the picture keeps its shape.
const MAX_NOTE_PICTURE_PT = 255

/// The frame a picture is given: its own size in points (96 px per inch,
/// 72 pt per inch), scaled down to Excel's ceiling.
function notePictureSize(picture: NotePicture): { width: string; height: string } {
  const widthPx = Math.max(1, Math.round(picture.widthPx))
  const heightPx = Math.max(1, Math.round(picture.heightPx))
  let widthPt = (widthPx * 72) / 96
  let heightPt = (heightPx * 72) / 96
  const scale = Math.min(1, MAX_NOTE_PICTURE_PT / Math.max(widthPt, heightPt))
  widthPt *= scale
  heightPt *= scale
  const points = (value: number): string => `${Math.max(1, Math.round(value * 100) / 100)}pt`
  return { width: points(widthPt), height: points(heightPt) }
}

/// Writes a picture into a note: the media part, the relationship that
/// reaches it, and the fill the note's shape paints it with.
///
/// The relationship lives in the VML part's OWN rels — a different id space
/// from the worksheet's — so the id is allocated there and cannot collide
/// with a worksheet relationship.
async function writeNotePicture(
  pkg: MutableNotePackage,
  vmlPath: string,
  picture: NotePicture,
  touchedEntries: Set<string>,
): Promise<NoteShapePicture> {
  const extension = IMAGE_EXTENSIONS[picture.mediaType]
  const mediaPath = await allocatePartPath(pkg, 'xl/media/image', `.${extension}`)
  pkg.addBinary(mediaPath, Uint8Array.from(Buffer.from(picture.base64, 'base64')))
  touchedEntries.add(mediaPath)
  await registerContentTypeDefault(pkg, extension, picture.mediaType, touchedEntries)
  const relId = await appendRelationship(
    pkg,
    relsPathFor(vmlPath),
    IMAGE_REL_TYPE,
    relativeTarget(vmlPath, mediaPath),
  )
  const title = picture.name ? ` o:title="${escapeXml(picture.name)}"` : ''
  const size = notePictureSize(picture)
  return {
    fill: `<v:fill o:relid="${relId}"${title} recolor="t" rotate="t" type="frame"/>`,
    width: size.width,
    height: size.height,
  }
}

/// New or explicitly replaced pictures get their own media relationship.
async function notePictureFills(
  pkg: MutableNotePackage,
  vmlPath: string,
  notes: readonly SheetNote[],
  touchedEntries: Set<string>,
): Promise<Map<string, NoteShapePicture>> {
  const fills = new Map<string, NoteShapePicture>()
  for (const note of notes) {
    if (note.picture) {
      fills.set(noteImageKey(note), await writeNotePicture(pkg, vmlPath, note.picture, touchedEntries))
    }
  }
  return fills
}

function noteShape(
  note: SheetNote,
  index: number,
  firstId: number,
  picture?: NoteShapePicture,
  existingId?: string,
): string {
  // Anchor: from one column right of the cell, spanning ~3 columns / 4 rows.
  const anchor = [note.column + 1, 15, note.row, 2, note.column + 4, 15, note.row + 4, 2].join(',')
  // A shape showing a picture keeps neither the yellow fill nor the drop
  // shadow: painted behind, they would hide the picture the note exists for.
  // The picture rides on the shape as its fill, spelled the way the source
  // spelled it.
  const paint = picture
    ? ` o:insetmode="auto">${picture.fill}`
    : ' fillcolor="#ffffe1" o:insetmode="auto">' +
      '<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/>'
  // The frame is the picture's size: a fill is stretched to the frame it
  // paints, so a frame the size of the text box would squash the photograph.
  const size = picture
    ? `${picture.width ? `width:${picture.width};` : ''}${picture.height ? `height:${picture.height};` : ''}`
    : 'width:108pt;height:60pt;'
  return (
    `<v:shape id="${existingId === undefined ? `_x0000_s${firstId + index}` : escapeXml(existingId)}" type="#_x0000_t202"` +
    ' style="position:absolute;margin-left:80pt;margin-top:2pt;' +
    `${size}z-index:${index + 1};visibility:hidden"${paint}` +
    '<v:path o:connecttype="none"/>' +
    '<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>' +
    '<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>' +
    `<x:Anchor>${anchor}</x:Anchor>` +
    '<x:AutoFill>False</x:AutoFill>' +
    `<x:Row>${note.row}</x:Row><x:Column>${note.column}</x:Column></x:ClientData>` +
    '</v:shape>'
  )
}

/** Keep controls and surviving note shapes in their original drawing positions. */
function keepNoteShapes(xml: string, notes: readonly SheetNote[]) {
  const wanted = new Set(notes.filter(note => note.picture === undefined).map(noteImageKey))
  const kept = new Set<string>()
  const existingIds = new Map<string, string>()
  const vml = replaceBlocks(xml, xmlBlocks(xml, 'shape'), shape => {
    const client = xmlBlocks(shape.body, 'ClientData').find(block => attribute(block.open, 'ObjectType') === 'Note')
    if (!client) return rawBlock(shape)
    const row = xmlBlocks(client.body, 'Row')[0]?.body.trim()
    const column = xmlBlocks(client.body, 'Column')[0]?.body.trim()
    if (row === undefined || column === undefined || !/^\d+$/.test(row) || !/^\d+$/.test(column)) return ''
    const key = `${Number(column)}:${Number(row)}`
    const id = attribute(shape.open, 'id')
    if (id) existingIds.set(key, id)
    if (!wanted.delete(key)) return ''
    kept.add(key)
    return rawBlock(shape)
  })
  return { vml, added: notes.filter(note => !kept.has(noteImageKey(note))), existingIds }
}

function appendRel(relsXml: string, id: string, type: string, target: string): string {
  const updated = appendRelationshipRecord(relsXml, id, type, target)
  if (updated === undefined) throw new NoteEditError('Worksheet has no relationships root element.')
  return updated
}

function removeRel(relsXml: string, type: string, id?: string): string {
  const relationship = noteRelationship(relsXml, type, id)
  return relationship
    ? relsXml.slice(0, relationship.start) + relsXml.slice(relationship.end)
    : relsXml
}

async function removeContentTypeOverride(
  pkg: MutableNotePackage,
  partPath: string,
  touchedEntries: Set<string>,
): Promise<void> {
  const contentTypes = await pkg.readText(CONTENT_TYPES_PATH)
  const stripped = removePartOverride(contentTypes, partPath)
  if (stripped !== contentTypes) {
    pkg.write(CONTENT_TYPES_PATH, stripped)
    touchedEntries.add(CONTENT_TYPES_PATH)
  }
}

function shiftedNoteCell(cell: NoteCell, ops: readonly StructuralOp[]): NoteCell | null {
  const { row, column } = cell
  const moved = shiftCellArea(
    { startRow: row, endRow: row, startColumn: column, endColumn: column },
    ops,
  )
  if (!moved) return null
  if (moved.startRow >= MAX_GRID_ROWS || moved.startColumn >= MAX_GRID_COLUMNS) {
    throw new StructuralShiftError(
      `A row or column change would move note ${cellRef(cell)} off the sheet.`,
    )
  }
  return { row: moved.startRow, column: moved.startColumn }
}

function shiftedNoteRef(ref: string, ops: readonly StructuralOp[]): string | null {
  const anchor = ref.split(':', 1)[0]!.replaceAll('$', '').toUpperCase()
  if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(anchor)) return ref
  const { startRow: row, startColumn: column } = parseRef(anchor)
  if (row >= MAX_GRID_ROWS || column >= MAX_GRID_COLUMNS) return ref
  const moved = shiftedNoteCell({ row, column }, ops)
  if (!moved) return null
  return moved.row === row && moved.column === column ? ref : cellRef(moved)
}

function shiftCommentEntries(
  xml: string,
  kind: 'legacy' | 'threaded',
  ops: readonly StructuralOp[],
) {
  const [node] = childElements(xml)
  if (!node) return xml
  const root = withNamespaces(node, new Map())
  const threaded = kind === 'threaded'
  const parent = threaded
    ? root.local === 'ThreadedComments' && root.namespace === THREADED_NS
      ? root
      : undefined
    : root.local === 'comments'
      ? scopedChildren(root).find((child) => isElement(child, 'commentList', root.namespace))
      : undefined
  if (!parent) return xml
  const name = threaded ? 'threadedComment' : 'comment'
  const entries = scopedChildren(parent).filter((child) => isElement(child, name, parent.namespace))
  const updatedEntries = new Map<ScopedElement, string>()
  const deleted = new Set<ScopedElement>()
  const descendants = new Map<string, ScopedElement[]>()
  for (const entry of entries) {
    const parentId = threaded ? entry.attributes.get('parentId') : undefined
    if (parentId !== undefined) {
      const key = parentId.toUpperCase()
      const replies = descendants.get(key)
      if (replies) replies.push(entry)
      else descendants.set(key, [entry])
    }
    const ref = entry.attributes.get('ref')
    if (ref === undefined) continue
    const moved = shiftedNoteRef(ref, ops)
    if (moved === null) deleted.add(entry)
    else if (moved !== ref) {
      const open = entry.opening.replace(
        XML_ATTRIBUTE,
        (full, prefix: string, name: string, double?: string) => {
          if (name !== 'ref') return full
          const quote = double === undefined ? "'" : '"'
          return `${prefix}${quote}${moved}${quote}`
        },
      )
      updatedEntries.set(entry, open + entry.xml.slice(entry.opening.length))
    }
  }
  // A reply may omit its own ref and refer to the cell through its parent.
  for (const entry of deleted) {
    const id = entry.attributes.get('id')
    if (id !== undefined) {
      for (const child of descendants.get(id.toUpperCase()) ?? []) deleted.add(child)
    }
  }
  if (!updatedEntries.size && !deleted.size) return xml
  const body = applyPatches(parent.inner, [
    ...[...updatedEntries].flatMap(([entry, updated]) =>
      deleted.has(entry) ? [] : [patchElement(entry, updated)],
    ),
    ...[...deleted].map((entry) => patchElement(entry, '')),
  ])
  // A part whose last annotation disappeared can be removed, unless it also
  // holds extension data at the root or inside the comment list.
  if (
    body.trim() === '' &&
    entries.length === deleted.size &&
    (threaded ||
      scopedChildren(root).every(
        (child) =>
          isElement(child, 'authors', root.namespace) ||
          isElement(child, 'commentList', root.namespace),
      ))
  ) {
    return null
  }
  const updated = replaceElementBody(parent, body)
  const start = threaded ? root.start : root.start + root.opening.length + parent.start
  return xml.slice(0, start) + updated + xml.slice(start + parent.xml.length)
}

function shiftVmlNoteShapes(xml: string, ops: readonly StructuralOp[]): string {
  return replaceBlocks(xml, xmlBlocks(xml, 'shape'), (shape) => {
    const client = xmlBlocks(shape.body, 'ClientData').find(
      (block) => attribute(block.open, 'ObjectType') === 'Note',
    )
    if (!client) return rawBlock(shape)
    const row = xmlBlocks(client.body, 'Row')[0]
    const column = xmlBlocks(client.body, 'Column')[0]
    if (!row || !column || !/^\d+$/.test(row.body.trim()) || !/^\d+$/.test(column.body.trim())) {
      return rawBlock(shape)
    }
    const original = { row: Number(row.body), column: Number(column.body) }
    if (original.row >= MAX_GRID_ROWS || original.column >= MAX_GRID_COLUMNS) return rawBlock(shape)
    const moved = shiftedNoteCell(original, ops)
    if (!moved) return ''
    const rowDelta = moved.row - original.row
    const columnDelta = moved.column - original.column
    if (rowDelta === 0 && columnDelta === 0) return rawBlock(shape)
    const anchor = xmlBlocks(client.body, 'Anchor')[0]
    const blocks = [row, column, ...(anchor ? [anchor] : [])].sort((a, b) => a.start - b.start)
    const body = replaceBlocks(client.body, blocks, (block) => {
      if (block === row) return rowDelta ? withBody(block, String(moved.row)) : rawBlock(block)
      if (block === column)
        return columnDelta ? withBody(block, String(moved.column)) : rawBlock(block)
      const values = block.body.split(',')
      if (values.length !== 8 || values.some((value) => !/^\s*\d+\s*$/.test(value)))
        return rawBlock(block)
      // Move the popup with its note. A row move can split the rows the popup
      // used to cover, so preserve its shape relative to the owning cell.
      for (const [index, delta, max] of [
        [0, columnDelta, MAX_GRID_COLUMNS],
        [4, columnDelta, MAX_GRID_COLUMNS],
        [2, rowDelta, MAX_GRID_ROWS],
        [6, rowDelta, MAX_GRID_ROWS],
      ] as const) {
        if (delta === 0) continue
        const position = Math.min(max - 1, Math.max(0, Number(values[index]) + delta))
        values[index] = values[index]!.replace(/\d+/, String(position))
      }
      return withBody(block, values.join(','))
    })
    return withBody(
      shape,
      replaceBlocks(shape.body, [client], (block) => withBody(block, body)),
    )
  })
}

/** Shift persisted annotations before a snapshot in the new cell coordinates. */
export async function shiftSheetAnnotations(
  pkg: MutableNotePackage & { canPatch(path: string): Promise<boolean> },
  worksheetPath: string,
  worksheetXml: string,
  relsXml: string,
  ops: readonly StructuralOp[],
  touchedEntries: Set<string>,
): Promise<void> {
  const read = async (partPath: string) => {
    if (!(await pkg.canPatch(partPath))) {
      throw new StructuralShiftError(
        `${partPath} is too large to rewrite — rows/columns cannot shift here.`,
      )
    }
    return pkg.readText(partPath)
  }
  let rels = relsXml
  let hasAnnotationPart = false
  for (const [type, kind] of [
    [COMMENTS_REL_TYPE, 'legacy'],
    [THREADED_COMMENTS_REL_TYPE, 'threaded'],
  ] as const) {
    const target = relTarget(rels, type)
    if (!target) continue
    const path = resolveRelTarget(worksheetPath, target)
    if (!(await pkg.has(path))) continue
    hasAnnotationPart = true
    const xml = await read(path)
    const shifted = shiftCommentEntries(xml, kind, ops)
    if (shifted === xml) continue
    if (shifted === null) {
      pkg.remove(path)
      rels = removeRel(rels, type)
      await removeContentTypeOverride(pkg, path, touchedEntries)
    } else {
      pkg.write(path, shifted)
    }
    touchedEntries.add(path)
  }
  if (rels !== relsXml) {
    const relsPath = relsPathFor(worksheetPath)
    pkg.write(relsPath, rels)
    touchedEntries.add(relsPath)
  }
  if (!hasAnnotationPart) return
  const drawingId = legacyDrawingId(legacyDrawing(worksheetXml))
  const vmlTarget = drawingId && relTarget(rels, VML_REL_TYPE, drawingId)
  if (!vmlTarget) return
  const vmlPath = resolveRelTarget(worksheetPath, vmlTarget)
  if (!(await pkg.has(vmlPath))) return
  const vml = await read(vmlPath)
  const shifted = shiftVmlNoteShapes(vml, ops)
  if (vml !== shifted) {
    pkg.write(vmlPath, shifted)
    touchedEntries.add(vmlPath)
  }
}

const EMPTY_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '</Relationships>'

/// CT_Worksheet order: legacyDrawing follows drawing and precedes these.
const AFTER_LEGACY_DRAWING = new Set([
  'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst',
])

function ensureLegacyDrawingElement(worksheetXml: string, rid: string): string {
  if (legacyDrawing(worksheetXml)) return worksheetXml
  worksheetXml = ensureRelationshipNamespace(worksheetXml)
  const root = worksheetRoot(worksheetXml)
  if (!root || root.opening.endsWith('/>')) throw new NoteEditError('Worksheet has no closing element.')
  const prefix = root.name.slice(0, -root.local.length)
  const binding = relationshipNamespaceOverride('', root.opening)
  const element = `<${prefix}legacyDrawing${binding} r:id="${rid}"/>`
  const anchor = scopedChildren(root).find(({ local, namespace }) =>
    namespace === root.namespace && AFTER_LEGACY_DRAWING.has(local),
  )
  const offset = root.start + root.opening.length + (anchor?.start ?? root.inner.length)
  return worksheetXml.slice(0, offset) + element + worksheetXml.slice(offset)
}

/// Replaces the worksheet's whole comment set (empty list removes it).
export async function applySheetNotes(
  pkg: MutableNotePackage,
  worksheetPath: string,
  notes: readonly SheetNote[],
  touchedEntries: Set<string>,
): Promise<void> {
  const relsPath = relsPathFor(worksheetPath)
  const hasRels = await pkg.has(relsPath)
  let relsXml = hasRels ? await pkg.readText(relsPath) : EMPTY_RELS
  const existingCommentsTarget = relTarget(relsXml, COMMENTS_REL_TYPE)
  const existingCommentsPath =
    existingCommentsTarget === null ? null : resolveRelTarget(worksheetPath, existingCommentsTarget)
  const worksheetXml = await pkg.readText(worksheetPath)
  const drawing = legacyDrawing(worksheetXml)
  const drawingId = legacyDrawingId(drawing)
  const existingVmlTarget =
    drawingId === undefined ? null : relTarget(relsXml, VML_REL_TYPE, drawingId)
  const existingVmlPath =
    existingVmlTarget === null ? null : resolveRelTarget(worksheetPath, existingVmlTarget)
  let relsChanged = false

  const originalComments =
    existingCommentsPath !== null && (await pkg.has(existingCommentsPath))
      ? await pkg.readText(existingCommentsPath)
      : undefined
  const existingLegacy = parseLegacyComments(originalComments ?? '')
  const threaded = await syncThreadedComments(
    pkg,
    worksheetPath,
    relsXml,
    new Map(notes.map((note) => [cellRef(note), note])),
    existingLegacy,
    touchedEntries,
  )
  if (threaded.relsXml !== relsXml) {
    relsXml = threaded.relsXml
    relsChanged = true
  }
  if (threaded.partRemoved && threaded.partPath !== null) {
    relsXml = removeRel(relsXml, THREADED_COMMENTS_REL_TYPE)
    relsChanged = true
    await removeContentTypeOverride(pkg, threaded.partPath, touchedEntries)
  }

  if (notes.length === 0) {
    if (existingCommentsPath === null) {
      if (relsChanged) {
        pkg.write(relsPath, relsXml)
        touchedEntries.add(relsPath)
      }
      return
    }
    pkg.remove(existingCommentsPath)
    touchedEntries.add(existingCommentsPath)
    relsXml = removeRel(relsXml, COMMENTS_REL_TYPE)
    await removeContentTypeOverride(pkg, existingCommentsPath, touchedEntries)
    if (existingVmlPath !== null && (await pkg.has(existingVmlPath))) {
      const { vml: remaining } = keepNoteShapes(await pkg.readText(existingVmlPath), [])
      if (xmlBlocks(remaining, 'shape').length) {
        pkg.write(existingVmlPath, remaining)
      } else {
        pkg.remove(existingVmlPath)
        relsXml = removeRel(relsXml, VML_REL_TYPE, drawingId)
        if (drawing) {
          const withoutLegacy = applyPatches(worksheetXml, [patchElement(drawing, '')])
          pkg.write(worksheetPath, withoutLegacy)
          touchedEntries.add(worksheetPath)
        }
      }
      touchedEntries.add(existingVmlPath)
    }
    pkg.write(relsPath, relsXml)
    touchedEntries.add(relsPath)
    return
  }

  // Comments part: rewrite in place, or allocate a fresh one.
  let commentsPath = existingCommentsPath
  if (commentsPath === null) {
    commentsPath = await nextFreePath(pkg, (index) => `xl/comments${index}.xml`)
    const rid = nextFreeRelationshipId(relsXml)
    const target = `../${commentsPath.replace(/^xl\//, '')}`
    relsXml = appendRel(relsXml, rid, COMMENTS_REL_TYPE, target)
    relsChanged = true
    pkg.add(commentsPath, buildCommentsXml(notes, threaded.legacy))
  } else {
    const comments = originalComments === undefined
      ? buildCommentsXml(notes, threaded.legacy)
      : patchCommentsXml(originalComments, notes, threaded.legacy, existingLegacy)
    if (comments !== originalComments) pkg.write(commentsPath, comments)
  }
  touchedEntries.add(commentsPath)

  // VML part: append new or explicitly repainted shapes without moving the survivors.
  if (existingVmlPath !== null && (await pkg.has(existingVmlPath))) {
    const original = await pkg.readText(existingVmlPath)
    const { vml, added, existingIds } = keepNoteShapes(original, notes)
    let updated = vml
    if (added.length) {
      const end = vml.lastIndexOf('</xml>')
      if (end === -1) throw new NoteEditError(`${existingVmlPath} is not a VML drawing.`)
      const firstId = nextShapeId(original)
      const pictures = await notePictureFills(pkg, existingVmlPath, added, touchedEntries)
      const root = childElements(vml)[0]
      const bindings = root ? withNamespaces(root, new Map()).namespaces : new Map()
      const declarations = (
        [
          ['v', VML_NS],
          ['o', VML_OFFICE_NS],
          ['x', VML_EXCEL_NS],
        ] as const
      )
        .filter(([prefix, ns]) => bindings.get(prefix) !== ns)
        .map(([prefix, ns]) => ` xmlns:${prefix}="${ns}"`)
        .join('')
      const shapes = added
        .map((note, index) => {
          const key = noteImageKey(note)
          return noteShape(note, index, firstId, pictures.get(key), existingIds.get(key)).replace(
            '<v:shape',
            `<v:shape${declarations}`,
          )
        })
        .join('')
      updated = vml.slice(0, end) + shapes + vml.slice(end)
    }
    if (updated !== original) {
      pkg.write(existingVmlPath, updated)
      touchedEntries.add(existingVmlPath)
    }
  } else {
    const vmlPath = await nextFreePath(pkg, (index) => `xl/drawings/vmlDrawing${index}.vml`)
    const rid = nextFreeRelationshipId(relsXml)
    relsXml = appendRel(relsXml, rid, VML_REL_TYPE, `../drawings/${vmlPath.split('/').pop()}`)
    relsChanged = true
    const pictures = await notePictureFills(pkg, vmlPath, notes, touchedEntries)
    const shapes = notes
      .map((note, index) =>
        noteShape(note, index, FIRST_NOTE_SHAPE_ID, pictures.get(noteImageKey(note))),
      )
      .join('')
    pkg.add(vmlPath, `${VML_HEADER}${shapes}</xml>`)
    touchedEntries.add(vmlPath)
    const withLegacy = ensureLegacyDrawingElement(worksheetXml, rid)
    if (withLegacy !== worksheetXml) {
      pkg.write(worksheetPath, withLegacy)
      touchedEntries.add(worksheetPath)
    }
  }

  await registerContentTypeOverride(pkg, commentsPath, COMMENTS_CONTENT_TYPE, touchedEntries)
  await registerContentTypeDefault(
    pkg, 'vml', 'application/vnd.openxmlformats-officedocument.vmlDrawing', touchedEntries,
  )

  if (relsChanged) {
    if (hasRels) pkg.write(relsPath, relsXml)
    else pkg.add(relsPath, relsXml)
    touchedEntries.add(relsPath)
  }
}
