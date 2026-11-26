/// OpenXML SDK-family producers bind the spreadsheetml namespace to a prefix
/// (<x:workbook><x:sheets>...), invisible to the text-based patch pipeline's
/// unprefixed element patterns. Parts are normalized at read time by making
/// equivalent names use the default namespace. Only
/// parts the planner rewrites reach the file, so untouched entries keep
/// their bytes; anything ambiguous returns the input unchanged (the save
/// then fails exactly as it did before this pass existed).

const NORMALIZABLE_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://schemas.openxmlformats.org/package/2006/content-types',
])

const SPREADSHEETML_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const OFFICE_RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

// Literal markup is read atomically. Only real element names and attributes
// participate in the namespace checks and the rewrite.
const MARKUP = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE\b[^>]*>|<(\/?)([^\s/>"'<=!?]+)(?:[^>"']|"[^"]*"|'[^']*')*>/g
const ATTRIBUTES = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function rootOpeningTag(xml: string) {
  for (const match of xml.matchAll(MARKUP)) {
    if (match[0].startsWith('<!DOCTYPE')) return undefined
    if (match[2] !== undefined) return match[1] === '' ? match : undefined
  }
  return undefined
}

/// Elements the pipeline appends carry r:-prefixed attributes; some
/// producers bind r on individual elements only, so the host root gets the
/// conventional binding before such an element is inserted.
export function ensureRelationshipNamespace(partXml: string): string {
  const root = rootOpeningTag(partXml)
  if (!root || [...root[0].matchAll(ATTRIBUTES)].some(([, name]) => name === 'xmlns:r')) return partXml
  const offset = root.index! + 1 + root[2]!.length
  return partXml.slice(0, offset) + ` xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"` + partXml.slice(offset)
}

export function normalizeOoxmlPartPrefix(xml: string): string {
  const root = rootOpeningTag(xml)
  const rootName = root?.[2]
  if (!root || !rootName) return xml
  const colon = rootName.indexOf(':')
  if (colon === 0) return xml
  const prefix = colon < 0 ? '' : rootName.slice(0, colon)
  const qualified = prefix ? `${prefix}:` : ''
  const namespace = prefix ? `xmlns:${prefix}` : 'xmlns'
  const rootAttrs = [...root[0].matchAll(ATTRIBUTES)]
  const declarations = rootAttrs.filter(([, name]) => name === namespace)
  const declaration = declarations[0]
  const uri = declaration?.[2] ?? declaration?.[3]
  if (!declaration || declarations.length !== 1 || uri === undefined || !NORMALIZABLE_NAMESPACES.has(uri)) return xml

  const rootAliases = new Set<string>()
  for (const [, key, double, single] of rootAttrs) {
    if (key?.startsWith('xmlns:') && (double ?? single) === uri) rootAliases.add(key.slice('xmlns:'.length))
  }
  if (rootAliases.size === 0 && xml.indexOf(uri, root.index! + root[0].length) === -1) return xml

  const defaults = new Map<number, { value: string; start: number; end: number }>()
  const localAliases = new Map<number, Array<[alias: string, equivalent: boolean]>>()
  let hasEquivalentAlias = rootAliases.size > 0
  let retainPrefix = false
  let addRelationshipBinding = prefix !== '' && uri === SPREADSHEETML_NAMESPACE && !rootAttrs.some(([, name]) => name === 'xmlns:r')
  for (const match of xml.matchAll(MARKUP)) {
    const [tag, closing, name] = match
    if (!name || closing) continue
    const attributes = tag.slice(name.length + 1)
    if (!attributes.includes('xmlns') && !(qualified && attributes.includes(qualified))
      && !attributes.includes('Requires') && !attributes.includes('Ignorable')
      && !attributes.includes('MustUnderstand')) continue
    for (const attribute of attributes.matchAll(ATTRIBUTES)) {
      const [, key, double, single] = attribute
      const value = double ?? single ?? ''
      if (key === 'xmlns') {
        const offset = match.index!
        if (defaults.has(offset)) return xml
        const start = attribute.index!
        defaults.set(offset, { value, start, end: start + attribute[0].length })
      }
      if (key?.startsWith('xmlns:')) {
        const alias = key.slice('xmlns:'.length)
        const equivalent = value === uri
        if (match.index !== root.index) {
          const offset = match.index!
          const bindings = localAliases.get(offset) ?? []
          bindings.push([alias, equivalent])
          localAliases.set(offset, bindings)
          hasEquivalentAlias ||= equivalent
        } else if (rootAliases.has(alias) && !equivalent) {
          return xml
        }
      }
      if (qualified && key?.startsWith(qualified)) retainPrefix = true
      if (qualified && key && /(?:^|:)(?:Requires|Ignorable|MustUnderstand|ProcessContent|PreserveElements|PreserveAttributes)$/.test(key)
        && value.trim().split(/\s+/).some(token => token === prefix || token.startsWith(qualified))) retainPrefix = true
      if (key === 'xmlns:r' && value !== OFFICE_RELATIONSHIPS_NAMESPACE) addRelationshipBinding = false
    }
  }
  if (!hasEquivalentAlias) return xml

  const relationshipBinding = addRelationshipBinding ? ` xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"` : ''
  const bindings = ` xmlns="${uri}"` + (retainPrefix ? declaration[0] : '') + relationshipBinding
  const declarationOffset = declaration.index! - rootName.length - 1
  const scopes: Array<{ aliases: Set<string>; original: string; normalized: string }> = []
  return xml.replace(MARKUP, (tag, closing: string, name: string | undefined, offset: number) => {
    if (!name) return tag
    const parent = closing ? scopes.pop() : scopes.at(-1)
    let aliases = parent?.aliases ?? rootAliases
    const local = localAliases.get(offset)
    if (local) {
      aliases = new Set(aliases)
      for (const [alias, equivalent] of local) {
        if (equivalent) aliases.add(alias)
        else aliases.delete(alias)
      }
    }
    const separator = name.indexOf(':')
    const stripPrefix = separator > 0 && aliases.has(name.slice(0, separator))
    const normalizedName = stripPrefix ? name.slice(separator + 1) : name
    const tail = tag.slice(1 + closing.length + name.length)
    if (closing) return `</${normalizedName}${tail}`
    const localDefault = defaults.get(offset)
    const original = localDefault?.value ?? parent?.original ?? ''
    const inherited = localDefault?.value ?? parent?.normalized ?? ''
    const normalized = stripPrefix ? uri : (separator > 0 ? inherited : original)
    if (!tag.endsWith('/>')) scopes.push({ aliases, original, normalized })
    if (offset === root.index && !localDefault) {
      return `<${normalizedName}${tail.slice(0, declarationOffset)}${bindings}${tail.slice(declarationOffset + declaration[0].length)}`
    }
    const rootRelationships = offset === root.index ? relationshipBinding : ''
    if (normalized === inherited) return `<${normalizedName}${rootRelationships}${tail}`
    // Restore the original default on unqualified descendants if an ancestor's namespace changed.
    const binding = ` xmlns="${normalized.replaceAll('"', '&quot;')}"`
    if (localDefault) {
      return `<${normalizedName}${rootRelationships}${tail.slice(0, localDefault.start)}${binding}${tail.slice(localDefault.end)}`
    }
    return `<${normalizedName}${binding}${tail}`
  })
}
