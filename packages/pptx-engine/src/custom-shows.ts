import { topLevelChildren } from './generate'
import type { OpenedPptx } from './index'
import { unescapeXml } from './notes'
import { escapeXmlAttr } from './xml-utils'
import { resolveTarget } from './zip'

export interface CustomShowInfo {
  id: string
  name: string
  slidePaths: string[]
}

const PRESENTATION = 'ppt/presentation.xml'
const MAX_ID = 0xffffffff
const AFTER_CUSTOM_SHOW_LIST = new Set([
  'p:photoAlbum', 'p:custDataLst', 'p:kinsoku', 'p:defaultTextStyle', 'p:modifyVerifier', 'p:extLst',
])

type XmlSpan = ReturnType<typeof topLevelChildren>[number]
const ATTRIBUTE = /(\s+)([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')/g

function openingTag(xml: string, { start, end }: XmlSpan): string {
  return /^(?:"[^"]*"|'[^']*'|[^"'>])*?>/.exec(xml.slice(start, end))?.[0] ?? ''
}

function children(xml: string, span: XmlSpan): XmlSpan[] {
  const opening = openingTag(xml, span)
  return opening.endsWith('/>') ? [] : topLevelChildren(xml, span.start + opening.length, xml.lastIndexOf('</', span.end - 1))
}

function attribute(tag: string, name: string): string | undefined {
  for (const [, , key, , value] of tag.matchAll(ATTRIBUTE)) {
    if (key === name) return unescapeXml(value!.slice(1, -1))
  }
}

function numericId(value: string): string | undefined {
  const number = Number(value)
  return /^\d+$/.test(value) && number <= MAX_ID ? String(number) : undefined
}

function slidePathsByRelationship(opened: OpenedPptx): Map<string, string> {
  const slidePaths = new Set(opened.deck.slides.map(slide => slide.path))
  const paths = new Map<string, string>()
  for (const rel of opened.archive.readRels(PRESENTATION).values()) {
    if (rel.targetMode === 'External' || !rel.type.endsWith('/slide')) continue
    const path = resolveTarget(PRESENTATION, rel.target)
    if (slidePaths.has(path)) paths.set(rel.id, path)
  }
  return paths
}

function readList(xml: string) {
  const root = topLevelChildren(xml, 0, xml.length).find(span => span.name === 'p:presentation')
  const properties = root ? children(xml, root) : []
  const list = properties.find(span => span.name === 'p:custShowLst')
  const shows = list ? children(xml, list).filter(span => span.name === 'p:custShow') : []
  return { root, properties, list, shows }
}

export function getCustomShows(opened: OpenedPptx): CustomShowInfo[] {
  const xml = opened.archive.readText(PRESENTATION)
  if (!xml) return []
  const { shows } = readList(xml)
  if (!shows.length) return []
  const paths = slidePathsByRelationship(opened)
  return shows.flatMap(show => {
    const tag = openingTag(xml, show)
    const id = numericId(attribute(tag, 'id') ?? '')
    const name = attribute(tag, 'name')
    const slides = children(xml, show).find(span => span.name === 'p:sldLst')
    if (id === undefined || name === undefined || !slides) return []
    const slidePaths = children(xml, slides).flatMap(span => {
      if (span.name !== 'p:sld') return []
      const path = paths.get(attribute(openingTag(xml, span), 'r:id') ?? '')
      return path === undefined ? [] : [path]
    })
    return [{ id, name, slidePaths }]
  })
}

export function setCustomShows(opened: OpenedPptx, shows: CustomShowInfo[]): boolean {
  const xml = opened.archive.readText(PRESENTATION)
  if (!xml) return false
  const { root, properties, list, shows: existingShows } = readList(xml)
  if (!root) return false

  const relationships = new Map(Array.from(slidePathsByRelationship(opened), ([rid, path]) => [path, rid]))
  const inputIds = new Set<string>()
  for (const show of shows) {
    if (typeof show?.id !== 'string' || !show.id || typeof show.name !== 'string' ||
        !Array.isArray(show.slidePaths) || !show.slidePaths.every(path => relationships.has(path))) return false
    const id = numericId(show.id) ?? show.id
    if (inputIds.has(id)) return false
    inputIds.add(id)
  }

  const existingById = new Map<string, XmlSpan>()
  for (const show of existingShows) {
    const id = numericId(attribute(openingTag(xml, show), 'id') ?? '')
    if (id !== undefined) existingById.set(id, show)
  }
  const occupied = new Set([...inputIds, ...existingById.keys()])
  let nextId = 1
  let showXml = ''
  for (const show of shows) {
    let id = numericId(show.id)
    if (id === undefined) {
      while (occupied.has(String(nextId))) nextId++
      id = String(nextId++)
    }
    const items = show.slidePaths.map(path => `<p:sld r:id="${escapeXmlAttr(relationships.get(path)!)}"/>`).join('')
    const slides = items ? `<p:sldLst>${items}</p:sldLst>` : '<p:sldLst/>'
    const existing = existingById.get(id)
    const tag = existing ? openingTag(xml, existing) : ''
    const name = escapeXmlAttr(show.name).replace(/[\r\n\t]/g, char => `&#${char.charCodeAt(0)};`)
    const originalSlides = existing && children(xml, existing).find(span => span.name === 'p:sldLst')
    if (existing && originalSlides) {
      // Keep extension elements and namespace declarations on imported shows.
      const renamed = tag.replace(ATTRIBUTE, (match, gap: string, key: string, equals: string) =>
        key === 'name' ? `${gap}${key}${equals}"${name}"` : match,
      )
      showXml += renamed + xml.slice(existing.start + tag.length, originalSlides.start) + slides + xml.slice(originalSlides.end, existing.end)
    } else {
      showXml += `<p:custShow name="${name}" id="${id}">${slides}</p:custShow>`
    }
  }

  const listTag = list ? openingTag(xml, list).replace(/\/>$/, '>') : '<p:custShowLst>'
  const replacement = showXml ? `${listTag}${showXml}</p:custShowLst>` : ''
  const insertion = properties.find(span => AFTER_CUSTOM_SHOW_LIST.has(span.name))?.start ?? xml.lastIndexOf('</', root.end - 1)
  const start = list?.start ?? insertion
  const end = list?.end ?? insertion
  const next = xml.slice(0, start) + replacement + xml.slice(end)
  if (next !== xml) opened.archive.entries.set(PRESENTATION, Buffer.from(next, 'utf8'))
  return true
}

/** Remove only the retired slide's references, before its presentation rId can be reused. */
export function removeCustomShowSlide(xml: string, rid: string): string {
  const { shows } = readList(xml)
  const removals = shows.flatMap(show => {
    const slides = children(xml, show).find(span => span.name === 'p:sldLst')
    return slides ? children(xml, slides).filter(span =>
      span.name === 'p:sld' && attribute(openingTag(xml, span), 'r:id') === rid,
    ) : []
  })
  for (const { start, end } of removals.reverse()) xml = xml.slice(0, start) + xml.slice(end)
  return xml
}

/** Reconnect an explicitly moved slide only if the surviving show order is unchanged. */
export function restoreCustomShowSlide(
  opened: OpenedPptx,
  path: string,
  memberships: readonly Pick<CustomShowInfo, 'id' | 'slidePaths'>[],
): void {
  if (!memberships.length) return
  const available = new Set(opened.deck.slides.map(slide => slide.path))
  const byId = new Map(memberships.map(show => [show.id, show.slidePaths]))
  const shows = getCustomShows(opened)
  let changed = false
  for (const show of shows) {
    const original = byId.get(show.id)
    if (!original?.includes(path)) continue
    const remaining = original.filter(slidePath => slidePath !== path && available.has(slidePath))
    if (show.slidePaths.length !== remaining.length || !show.slidePaths.every((value, index) => value === remaining[index])) continue
    show.slidePaths = original.filter(slidePath => available.has(slidePath))
    changed = true
  }
  if (changed) setCustomShows(opened, shows)
}
