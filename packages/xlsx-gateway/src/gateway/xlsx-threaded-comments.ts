/// Keeps `xl/threadedComments/*.xml` in step with a note rewrite. Excel
/// stores a modern comment twice: the thread part holds the real text and
/// the legacy comments part only mirrors it behind a "[Threaded comment]"
/// notice. Rewriting the mirror alone leaves Excel showing the stale thread.

import { decodeXlsxEscapes, decodeXmlText } from './xlsx-escapes.ts'
import { resolveRelTarget } from './xlsx-drawing-add.ts'
import { nextFreeRelationshipId } from './xlsx-sheets.ts'
import { rootTail } from './xlsx-root-tail.ts'

export const THREADED_COMMENTS_REL_TYPE =
  'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment'
const PERSONS_REL_TYPE = 'http://schemas.microsoft.com/office/2017/10/relationships/person'
const THREADED_COMMENTS_CONTENT_TYPE = 'application/vnd.ms-excel.threadedcomments+xml'
const PERSONS_CONTENT_TYPE = 'application/vnd.ms-excel.person+xml'
const THREADED_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments'
const WORKBOOK_PATH = 'xl/workbook.xml'
const WORKBOOK_RELS_PATH = 'xl/_rels/workbook.xml.rels'
const DEFAULT_PERSONS_PATH = 'xl/persons/person.xml'
const CONTENT_TYPES_PATH = '[Content_Types].xml'

const MIRROR_NOTICE =
  '[Threaded comment]\n\n' +
  'Your version of Excel allows you to read this threaded comment; however, any edits to it ' +
  'will get removed if the file is opened in a newer version of Excel. Learn more: ' +
  'https://go.microsoft.com/fwlink/?linkid=870924\n\nComment:\n    '

export interface LegacyCommentEntry {
  readonly author: string
  readonly text: string
}

export interface SheetThreadReply {
  readonly id: string
  readonly personId: string
  readonly author: string
  readonly dT: string
  readonly text: string
}

/// A threaded (modern) comment: the root's identity plus its replies. The
/// root text travels in the note's `text`.
export interface SheetThread {
  readonly id: string
  readonly personId: string
  readonly author: string
  readonly dT: string
  readonly done: boolean
  readonly replies: readonly SheetThreadReply[]
}

export interface ThreadedNote extends LegacyCommentEntry {
  /// Object: write this thread. `null`: the cell is a plain note now (a
  /// thread it had is dropped). Absent: legacy-only caller, see below.
  readonly thread?: SheetThread | null | undefined
}

interface ThreadedPackage {
  has(path: string): Promise<boolean>
  readText(path: string): Promise<string>
  write(path: string, content: string): void
  add(path: string, content: string): void
  remove(path: string): void
}

interface ThreadEntry {
  readonly raw: string
  readonly id: string
  readonly personId: string
  readonly dT: string
  readonly done: boolean
  readonly parentId: string | null
  readonly text: string
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function attribute(tag: string, name: string): string | null {
  for (const [, key, , value] of tag.matchAll(/\s+([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    if (key === name) return decodeXmlText(value!)
  }
  return null
}

function relationshipTarget(xml: string, type: string): string | null {
  for (const [tag] of xml.matchAll(/<!--[\s\S]*?-->|<(?:[\w.-]+:)?Relationship\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g)) {
    if (tag.startsWith('<!--')) continue
    if (attribute(tag,'Type') === type && attribute(tag,'TargetMode') !== 'External') {
      return attribute(tag,'Target')
    }
  }
  return null
}

function xmlText(text: string): string {
  return text.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map(part =>
    part.startsWith('<![CDATA[') ? part.slice(9, -3) : decodeXmlText(part),
  ).join('')
}

const THREAD_TEXT = /<([\w.-]+:)?text(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/\1text\s*>)/

function partRoot(xml: string, name: string) {
  for (const match of xml.matchAll(/<!--[\s\S]*?-->|<([\w.-]+:)?([\w.-]+)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/g)) {
    if (match[0].startsWith('<!--')) continue
    if (match[2] !== name) break
    return { prefix: match[1] ?? '', tag: match[0], index: match.index! }
  }
  throw new Error(`Invalid ${name} part.`)
}

function appendPartChildren(xml: string, name: string, children: string): string {
  const { prefix, tag, index } = partRoot(xml, name)
  const element = prefix + name
  if (tag.endsWith('/>')) {
    return xml.slice(0, index) + tag.slice(0, -2) + '>' + children +
      `</${element}>` + xml.slice(index + tag.length)
  }
  const tail = rootTail(xml, element)
  if (!tail) throw new Error(`Invalid ${name} part.`)
  return xml.slice(0, tail.rootClose) + children + xml.slice(tail.rootClose)
}

/// Stable person GUID derived from the display name, so the same user maps
/// to one `<person>` across sessions without storing anything (FNV-1a over
/// four seeds, laid out as a braced GUID like Excel's).
export function personIdFor(displayName: string): string {
  const words: string[] = []
  for (let seed = 0; seed < 4; seed += 1) {
    let hash = (0x811c9dc5 ^ (seed * 0x9e3779b9)) >>> 0
    for (const char of `${seed}:${displayName}`) {
      hash ^= char.codePointAt(0)!
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    words.push(hash.toString(16).padStart(8, '0').toUpperCase())
  }
  const hex = words.join('')
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}}`
}

/// Legacy `<comment>` entries keyed by cell reference, so the untouched
/// mirror of a thread (author `tc={id}`, notice text) survives the rewrite.
export function parseLegacyComments(commentsXml: string): Map<string, LegacyCommentEntry> {
  const authors = [...commentsXml.matchAll(/<(?:[\w.-]+:)?author\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?author\s*>)/g)].map((match) =>
    decodeXlsxEscapes(xmlText(match[1] ?? '')),
  )
  const entries = new Map<string, LegacyCommentEntry>()
  for (const match of commentsXml.matchAll(/<(?:[\w.-]+:)?comment\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?comment\s*>)/g)) {
    const ref = attribute(match[1]!, 'ref')
    if (ref === null) continue
    const authorId = Number(attribute(match[1]!, 'authorId') ?? -1)
    const text = [...(match[2] ?? '').matchAll(/<(?:[\w.-]+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?t\s*>)/g)]
      .map((part) => decodeXlsxEscapes(xmlText(part[1] ?? '')))
      .join('')
    entries.set(ref, { author: authors[authorId] ?? '', text })
  }
  return entries
}

function parseThreads(xml: string): Map<string, ThreadEntry[]> {
  const threads = new Map<string, ThreadEntry[]>()
  for (const match of xml.matchAll(
    /<([\w.-]+:)?threadedComment(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/\1threadedComment\s*>)/g,
  )) {
    const attrs = match[2]!
    const ref = attribute(attrs, 'ref')
    if (ref === null) continue
    const textMatch = THREAD_TEXT.exec(match[3] ?? '')
    const done = attribute(attrs, 'done')
    const entry: ThreadEntry = {
      raw: match[0],
      id: attribute(attrs, 'id') ?? '',
      personId: attribute(attrs, 'personId') ?? '',
      dT: attribute(attrs, 'dT') ?? '',
      done: done === '1' || done === 'true',
      parentId: attribute(attrs, 'parentId'),
      text: xmlText(textMatch?.[3] ?? ''),
    }
    const list = threads.get(ref)
    if (list) list.push(entry)
    else threads.set(ref, [entry])
  }
  return threads
}

/** Reads the same root/reply grouping that the note writer synchronizes. */
export function parseSheetCommentThreads(xml: string, personsXml: string) {
  const authors = new Map<string, string>()
  for (const match of personsXml.matchAll(/<(?:[\w.-]+:)?person\b([^>]*)>/g)) {
    const id = attribute(match[1]!, 'id')
    const displayName = attribute(match[1]!, 'displayName')
    if (id !== null && displayName !== null) authors.set(id, displayName)
  }
  const threads = new Map<string, SheetThread & {text:string;displayText:string;structured:boolean}>()
  for (const [ref, entries] of parseThreads(xml)) {
    const root = entries.find(entry => entry.parentId === null)
    if (!root) continue
    const describe = ({id,personId,dT,text}:ThreadEntry) => ({
      id,personId,dT,text,author:authors.get(personId) ?? '',
    })
    const replies = entries.filter(entry => entry !== root)
    threads.set(ref, {...describe(root),done:root.done,replies:replies.map(describe),
      displayText:threadDisplayText(entries),
      structured:replies.every(entry => entry.parentId === root.id),
    })
  }
  return threads
}

/// What the viewer shows for a thread (mirrors the sidecar reader): root
/// text followed by each reply in document order.
export function threadDisplayText(entries: readonly { readonly text: string }[]): string {
  return entries.map((entry) => entry.text).join('\n\n')
}

export function threadedMirrorText(text: string): string {
  return `${MIRROR_NOTICE}${text}`
}

/// Excel's legacy mirror of a whole thread: the notice, the root under
/// "Comment:", then each reply under its own "Reply:" line.
export function threadMirrorText(rootText: string, replies: readonly { text: string }[]): string {
  return (
    threadedMirrorText(rootText) + replies.map((reply) => `\nReply:\n    ${reply.text}`).join('')
  )
}

function entryXml(
  prefix: string,
  ref: string,
  entry: { id: string; personId: string; dT: string; text: string },
  parentId: string | null,
  done: boolean,
): string {
  return (
    `<${prefix}threadedComment ref="${escapeXml(ref)}" dT="${escapeXml(entry.dT)}"` +
    ` personId="${escapeXml(entry.personId)}" id="${escapeXml(entry.id)}"` +
    (parentId === null ? '' : ` parentId="${escapeXml(parentId)}"`) +
    (done ? ' done="1"' : '') +
    `><${prefix}text>${escapeXml(entry.text)}</${prefix}text></${prefix}threadedComment>`
  )
}

function threadXml(prefix: string, ref: string, note: ThreadedNote, thread: SheetThread): string {
  return (
    entryXml(prefix, ref, { ...thread, text: note.text }, null, thread.done) +
    thread.replies.map((reply) => entryXml(prefix, ref, reply, thread.id, false)).join('')
  )
}

function sameThread(entries: readonly ThreadEntry[], note: ThreadedNote, thread: SheetThread) {
  const root = entries.find((entry) => entry.parentId === null)
  if (!root) return false
  const replies = entries.filter((entry) => entry !== root)
  if (
    root.id !== thread.id ||
    root.personId !== thread.personId ||
    root.dT !== thread.dT ||
    root.done !== thread.done ||
    root.text !== note.text ||
    replies.length !== thread.replies.length
  ) {
    return false
  }
  return replies.every((entry, index) => {
    const reply = thread.replies[index]!
    return (
      entry.id === reply.id &&
      entry.personId === reply.personId &&
      entry.dT === reply.dT &&
      entry.text === reply.text &&
      entry.parentId === thread.id
    )
  })
}

interface PersonsPart {
  readonly path: string
  readonly exists: boolean
  xml: string
  readonly ids: Set<string>
}

async function readPersons(pkg: ThreadedPackage): Promise<PersonsPart> {
  let path = DEFAULT_PERSONS_PATH
  if (await pkg.has(WORKBOOK_RELS_PATH)) {
    const rels = await pkg.readText(WORKBOOK_RELS_PATH)
    const target = relationshipTarget(rels, PERSONS_REL_TYPE)
    if (target) path = resolveRelTarget(WORKBOOK_PATH, target)
  }
  if (!(await pkg.has(path))) {
    return {
      path: DEFAULT_PERSONS_PATH,
      exists: false,
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<personList xmlns="${THREADED_NS}"></personList>`,
      ids: new Set(),
    }
  }
  const xml = await pkg.readText(path)
  const ids = new Set(
    [...xml.matchAll(/<(?:[\w.-]+:)?person(?=[\s/>])([^>]*)>/g)]
      .map((match) => attribute(match[1]!, 'id'))
      .filter((id): id is string => id !== null),
  )
  return { path, exists: true, xml, ids }
}

function ensurePerson(persons: PersonsPart, id: string, displayName: string): boolean {
  if (persons.ids.has(id)) return false
  persons.ids.add(id)
  const name = escapeXml(displayName)
  const { prefix } = partRoot(persons.xml, 'personList')
  persons.xml = appendPartChildren(
    persons.xml,
    'personList',
    `<${prefix}person displayName="${name}" id="${escapeXml(id)}" userId="${name}" providerId="None"/>`,
  )
  return true
}

function appendRel(relsXml: string, id: string, type: string, target: string): string {
  return relsXml.replace(
    '</Relationships>',
    `<Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`,
  )
}

async function ensureContentType(
  pkg: ThreadedPackage,
  partName: string,
  contentType: string,
  touchedEntries: Set<string>,
): Promise<void> {
  const contentTypes = await pkg.readText(CONTENT_TYPES_PATH)
  if (contentTypes.includes(`PartName="/${partName}"`)) return
  pkg.write(
    CONTENT_TYPES_PATH,
    contentTypes.replace(
      '</Types>',
      `<Override PartName="/${partName}" ContentType="${contentType}"/></Types>`,
    ),
  )
  touchedEntries.add(CONTENT_TYPES_PATH)
}

async function savePersons(
  pkg: ThreadedPackage,
  persons: PersonsPart,
  touchedEntries: Set<string>,
): Promise<void> {
  if (persons.exists) {
    pkg.write(persons.path, persons.xml)
    touchedEntries.add(persons.path)
    return
  }
  pkg.add(persons.path, persons.xml)
  touchedEntries.add(persons.path)
  const hasRels = await pkg.has(WORKBOOK_RELS_PATH)
  const rels = hasRels
    ? await pkg.readText(WORKBOOK_RELS_PATH)
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  const updated = appendRel(
    rels,
    nextFreeRelationshipId(rels),
    PERSONS_REL_TYPE,
    'persons/person.xml',
  )
  if (hasRels) pkg.write(WORKBOOK_RELS_PATH, updated)
  else pkg.add(WORKBOOK_RELS_PATH, updated)
  touchedEntries.add(WORKBOOK_RELS_PATH)
  await ensureContentType(pkg, persons.path, PERSONS_CONTENT_TYPE, touchedEntries)
}

function replaceEntryText(raw: string, text: string): string {
  const escaped = escapeXml(text)
  if (THREAD_TEXT.test(raw)) {
    return raw.replace(THREAD_TEXT, (_tag, prefix = '', attrs: string) =>
      `<${prefix}text${attrs}>${escaped}</${prefix}text>`)
  }
  const prefix = /^<([\w.-]+:)?threadedComment/.exec(raw)?.[1] ?? ''
  const child = `<${prefix}text>${escaped}</${prefix}text>`
  if (raw.endsWith('/>')) return `${raw.slice(0, -2)}>${child}</${prefix}threadedComment>`
  return raw.replace(/<\/(?:[\w.-]+:)?threadedComment\s*>$/, closing => child + closing)
}

async function nextFreeThreadPath(pkg: ThreadedPackage): Promise<string> {
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `xl/threadedComments/threadedComment${index}.xml`
    if (!(await pkg.has(candidate))) return candidate
  }
  throw new Error('No free part name for the threaded comments part.')
}

export interface ThreadedSyncResult {
  /// Legacy entries to emit for threaded cells (keyed by cell reference);
  /// a note missing here is a plain legacy note.
  readonly legacy: Map<string, LegacyCommentEntry>
  /// True when the part was removed and its rel / content type must go.
  readonly partRemoved: boolean
  readonly partPath: string | null
  /// Worksheet rels after the sync (a new thread part adds its rel).
  readonly relsXml: string
}

/// Applies the note set to the thread part. Structured notes (`thread`
/// set) are written as given — unchanged threads keep their XML and legacy
/// mirror verbatim; `thread: null` drops the cell's thread (convert to
/// note). Legacy-only notes keep the older contract: an edited text rewrites
/// the root and folds the replies away, a removed note drops the thread, and
/// a thread whose person is unknown falls back to a plain legacy note.
export async function syncThreadedComments(
  pkg: ThreadedPackage,
  worksheetPath: string,
  relsXml: string,
  notes: ReadonlyMap<string, ThreadedNote>,
  existingLegacy: ReadonlyMap<string, LegacyCommentEntry>,
  touchedEntries: Set<string>,
): Promise<ThreadedSyncResult> {
  const target = relationshipTarget(relsXml, THREADED_COMMENTS_REL_TYPE)
  let partPath = target === null ? null : resolveRelTarget(worksheetPath, target)
  if (partPath !== null && !(await pkg.has(partPath))) partPath = null
  const structured = [...notes].filter(
    (entry): entry is [string, ThreadedNote & { thread: SheetThread }] =>
      entry[1].thread !== null && entry[1].thread !== undefined,
  )
  const none: ThreadedSyncResult = { legacy: new Map(), partRemoved: false, partPath, relsXml }
  if (partPath === null && structured.length === 0) return none

  const xml = partPath === null ? null : await pkg.readText(partPath)
  const threads = xml === null ? new Map<string, ThreadEntry[]>() : parseThreads(xml)
  const persons = await readPersons(pkg)
  let personsChanged = false
  const legacy = new Map<string, LegacyCommentEntry>()
  let updated =
    xml ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<ThreadedComments xmlns="${THREADED_NS}"></ThreadedComments>`
  const { prefix } = partRoot(updated, 'ThreadedComments')
  const written = new Set<string>()

  const writeThread = (ref: string, note: ThreadedNote, thread: SheetThread): string => {
    personsChanged = ensurePerson(persons, thread.personId, thread.author) || personsChanged
    for (const reply of thread.replies) {
      personsChanged = ensurePerson(persons, reply.personId, reply.author) || personsChanged
    }
    legacy.set(ref, {
      author: `tc=${thread.id}`,
      text: threadMirrorText(note.text, thread.replies),
    })
    written.add(ref)
    return threadXml(prefix, ref, note, thread)
  }

  for (const [ref, entries] of threads) {
    const note = notes.get(ref)
    const root = entries.find((entry) => entry.parentId === null) ?? entries[0]!
    if (note === undefined || note.thread === null) {
      for (const entry of entries) updated = updated.replace(entry.raw, '')
      continue
    }
    const mirror = existingLegacy.get(ref)
    if (note.thread !== undefined) {
      if (sameThread(entries, note, note.thread)) {
        legacy.set(
          ref,
          mirror ?? {
            author: `tc=${root.id}`,
            text: threadMirrorText(note.text, note.thread.replies),
          },
        )
        written.add(ref)
        continue
      }
      // Replies go first: the rewritten block repeats unchanged reply XML.
      for (const entry of entries) {
        if (entry !== root) updated = updated.replace(entry.raw, '')
      }
      updated = updated.replace(root.raw, () => writeThread(ref, note, note.thread!))
      continue
    }
    // Callers that read the legacy part (CLI) hand the mirror text back.
    const untouched = note.text === threadDisplayText(entries) || note.text === mirror?.text
    if (untouched) {
      legacy.set(ref, mirror ?? {
        author: `tc=${root.id}`,
        text: threadMirrorText(root.text, entries.filter(entry => entry !== root)),
      })
      continue
    }
    if (!persons.ids.has(root.personId)) {
      for (const entry of entries) updated = updated.replace(entry.raw, '')
      continue
    }
    for (const entry of entries) {
      const replacement = entry === root ? replaceEntryText(entry.raw, note.text) : ''
      updated = updated.replace(entry.raw, () => replacement)
    }
    legacy.set(ref, { author: `tc=${root.id}`, text: threadedMirrorText(note.text) })
  }

  const additions = structured
    .filter(([ref]) => !written.has(ref))
    .map(([ref, note]) => writeThread(ref, note, note.thread))
    .join('')
  if (additions.length > 0) {
    updated = appendPartChildren(updated, 'ThreadedComments', additions)
  }

  if (personsChanged) await savePersons(pkg, persons, touchedEntries)
  if (updated === xml) return { legacy, partRemoved: false, partPath, relsXml }
  if (!/<(?:[\w.-]+:)?threadedComment(?=[\s/>])/.test(updated)) {
    if (partPath !== null) {
      pkg.remove(partPath)
      touchedEntries.add(partPath)
    }
    return { legacy, partRemoved: partPath !== null, partPath, relsXml }
  }
  if (partPath === null) {
    partPath = await nextFreeThreadPath(pkg)
    pkg.add(partPath, updated)
    relsXml = appendRel(
      relsXml,
      nextFreeRelationshipId(relsXml),
      THREADED_COMMENTS_REL_TYPE,
      `../${partPath.replace(/^xl\//, '')}`,
    )
    await ensureContentType(pkg, partPath, THREADED_COMMENTS_CONTENT_TYPE, touchedEntries)
  } else {
    pkg.write(partPath, updated)
  }
  touchedEntries.add(partPath)
  return { legacy, partRemoved: false, partPath, relsXml }
}
