import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import type { PDFObject } from 'pdf-lib'

const key = PDFName.of
const unsupported = () => Object.assign(new Error('Unsupported PDF form merge'), { code: 'PDF_EDIT_UNSUPPORTED_STRUCTURE' })

function array(dict: PDFDict, name: string): PDFObject[] {
  const value = dict.lookup(key(name))
  if (value === undefined) return []
  if (!(value instanceof PDFArray)) throw unsupported()
  return value.asArray()
}

function resourceGroups(form: PDFDict): Map<PDFName, PDFDict> {
  const resources = form.lookup(key('DR'))
  if (resources === undefined) return new Map()
  if (!(resources instanceof PDFDict)) throw unsupported()
  const groups = new Map<PDFName, PDFDict>()
  for (const [category, ref] of resources.entries()) {
    if (category === key('ProcSet')) continue
    const group = form.context.lookup(ref)
    if (!(group instanceof PDFDict)) throw unsupported()
    groups.set(category, group)
  }
  return groups
}

function mergeResources(target: PDFDict, donor: PDFDict): Map<PDFName, PDFName> {
  const existing = resourceGroups(target)
  const incoming = resourceGroups(donor)
  const used = new Set([...existing.values(), ...incoming.values()].flatMap(group => group.keys()))
  const renamed = new Map<PDFName, PDFName>()
  let sequence = 0
  for (const [category, group] of incoming) {
    for (const name of group.keys()) {
      if (!existing.get(category)?.has(name) || renamed.has(name)) continue
      let alias: PDFName
      do { alias = key(`DyOfficeImport${++sequence}`) } while (used.has(alias))
      used.add(alias)
      renamed.set(name, alias)
    }
  }
  const resources = target.lookup(key('DR'))
  const merged = resources instanceof PDFDict ? resources.clone() : target.context.obj({})
  for (const [category, group] of incoming) {
    const combined = existing.get(category)?.clone() ?? target.context.obj({})
    for (const [name, ref] of group.entries()) combined.set(renamed.get(name) ?? name, ref)
    merged.set(category, combined)
  }
  const donorResources = donor.lookup(key('DR'))
  if (donorResources instanceof PDFDict && donorResources.has(key('ProcSet'))) {
    merged.set(key('ProcSet'), target.context.obj([...new Set([...array(merged, 'ProcSet'), ...array(donorResources, 'ProcSet')])]))
  }
  if (merged.keys().length) target.set(key('DR'), merged)
  return renamed
}

function rebindAppearance(appearance: PDFObject, renamed: Map<PDFName, PDFName>): PDFObject {
  if (!(appearance instanceof PDFString || appearance instanceof PDFHexString)) throw unsupported()
  if (!renamed.size) return appearance
  const data = Array.from(appearance.asBytes(), byte => String.fromCharCode(byte)).join('')
  // Default appearances are text state operators. Protect comments and string operands while rebinding names.
  const tokens = /%[^\r\n]*|<[^<>]*>|\(|\/[^\t\n\f\r \x00()[\]{}<>/%]+/g
  let rewritten = '', offset = 0
  for (let match = tokens.exec(data); match; match = tokens.exec(data)) {
    const token = match[0]
    if (token === '(') {
      let depth = 1
      while (tokens.lastIndex < data.length && depth) {
        const char = data[tokens.lastIndex++]
        if (char === '\\') tokens.lastIndex++
        else if (char === '(') depth++
        else if (char === ')') depth--
      }
      if (depth) throw unsupported()
    } else if (token.startsWith('/')) {
      const alias = renamed.get(key(token.slice(1)))
      if (alias) {
        rewritten += data.slice(offset, match.index) + alias.asString()
        offset = tokens.lastIndex
      }
    }
  }
  rewritten += data.slice(offset)
  if (rewritten === data) return appearance
  return PDFHexString.of(Array.from(rewritten, char => char.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
}

function fieldName(field: PDFDict): string {
  const title = field.lookup(key('T'))
  if (!(title instanceof PDFString || title instanceof PDFHexString)) throw unsupported()
  return title.decodeText()
}

/** The donor tree and its resources have already been copied into the target object context. */
export function mergePageForms(target: PDFDict, donor: PDFDict): void {
  if (target.has(key('XFA')) || donor.has(key('XFA'))) throw unsupported()
  const dict = (ref: PDFObject) => {
    const value = target.context.lookup(ref)
    if (!(value instanceof PDFDict)) throw unsupported()
    return value
  }
  const current = array(target, 'Fields'), incoming = array(donor, 'Fields')
  const names = new Set(current.map(ref => fieldName(dict(ref))))
  const reserved = new Set([...names, ...incoming.map(ref => fieldName(dict(ref)))])
  const renamed = mergeResources(target, donor)
  let fieldRenamed = false
  for (const ref of incoming) {
    const field = dict(ref), name = fieldName(field)
    if (names.has(name)) {
      let suffix = 2
      while (reserved.has(`${name}_${suffix}`)) suffix++
      const unique = `${name}_${suffix}`
      field.set(key('T'), PDFHexString.fromText(unique))
      reserved.add(unique)
      fieldRenamed = true
    } else names.add(name)
  }
  const seen = new Set<PDFDict>()
  function bind(field: PDFDict, da: PDFObject | undefined, q: PDFObject, depth: number) {
    if (depth > 64 || seen.has(field) || (fieldRenamed && (field.has(key('AA')) || field.has(key('A'))))) throw unsupported()
    seen.add(field)
    const own = field.lookup(key('DA'))
    const appearance = own === undefined ? da : rebindAppearance(own, renamed)
    const alignment = field.lookup(key('Q')) ?? q
    if (appearance && (own !== undefined || field.has(key('T')))) field.set(key('DA'), appearance)
    if (field.has(key('T')) && !field.has(key('Q'))) field.set(key('Q'), alignment)
    for (const child of array(field, 'Kids')) bind(dict(child), appearance, alignment, depth + 1)
  }
  const defaultAppearance = donor.lookup(key('DA'))
  const defaultDA = defaultAppearance === undefined ? undefined : rebindAppearance(defaultAppearance, renamed)
  for (const ref of incoming) bind(dict(ref), defaultDA, donor.lookup(key('Q')) ?? PDFNumber.of(0), 0)
  target.set(key('Fields'), target.context.obj([...current, ...incoming]))
  const order = [...array(target, 'CO'), ...array(donor, 'CO')]
  if (order.length) target.set(key('CO'), target.context.obj(order))
  if (donor.lookup(key('NeedAppearances')) === PDFBool.True) target.set(key('NeedAppearances'), PDFBool.True)
}
