/// OpenXML SDK-family producers bind the spreadsheetml namespace to a prefix
/// (<x:workbook><x:sheets>...), invisible to the text-based patch pipeline's
/// unprefixed element patterns. Parts are normalized at read time instead:
/// the prefix is stripped and re-declared as the default namespace. Only
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
  if (colon <= 0) return xml
  const prefix = rootName.slice(0, colon)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) return xml

  const qualified = `${prefix}:`
  const namespace = `xmlns:${prefix}`
  const rootAttrs = [...root[0].matchAll(ATTRIBUTES)]
  const declarations = rootAttrs.filter(([, name]) => name === namespace)
  const declaration = declarations[0]
  const uri = declaration?.[2] ?? declaration?.[3]
  if (!declaration || declarations.length !== 1 || uri === undefined || !NORMALIZABLE_NAMESPACES.has(uri)) return xml

  let retainPrefix = false
  let addRelationshipBinding = uri === SPREADSHEETML_NAMESPACE && !rootAttrs.some(([, name]) => name === 'xmlns:r')
  for (const [tag, closing, name] of xml.matchAll(MARKUP)) {
    if (!name || closing) continue
    const attributes = tag.slice(name.length + 1)
    if (!attributes.includes('xmlns') && !attributes.includes(qualified)
      && !attributes.includes('Requires') && !attributes.includes('Ignorable')
      && !attributes.includes('MustUnderstand')) continue
    for (const [, key, double, single] of attributes.matchAll(ATTRIBUTES)) {
      const value = double ?? single
      // A default binding or a conflicting rebinding can change the meaning of de-prefixed elements.
      if (key === 'xmlns' || (key === namespace && value !== uri)) return xml
      if (key?.startsWith(qualified)) retainPrefix = true
      if (key && /(?:^|:)(?:Requires|Ignorable|MustUnderstand|ProcessContent|PreserveElements|PreserveAttributes)$/.test(key)
        && value?.trim().split(/\s+/).some(token => token === prefix || token.startsWith(qualified))) retainPrefix = true
      if (key === 'xmlns:r' && value !== OFFICE_RELATIONSHIPS_NAMESPACE) addRelationshipBinding = false
    }
  }

  const bindings = ` xmlns="${uri}"`
    + (retainPrefix ? declaration[0] : '')
    + (addRelationshipBinding ? ` xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"` : '')
  const declarationOffset = declaration.index! - rootName.length - 1
  const defaultScopes: boolean[] = []
  return xml.replace(MARKUP, (tag, closing: string, name: string | undefined, offset: number) => {
    if (!name) return tag
    const stripPrefix = name.startsWith(qualified)
    const normalizedName = stripPrefix ? name.slice(qualified.length) : name
    const tail = tag.slice(1 + closing.length + name.length)
    if (closing) {
      defaultScopes.pop()
      return `</${normalizedName}${tail}`
    }
    const inherited = defaultScopes.at(-1) ?? false
    const usesDefault = stripPrefix || (name.includes(':') && inherited)
    if (!tag.endsWith('/>')) defaultScopes.push(usesDefault)
    if (offset === root.index) {
      return `<${normalizedName}${tail.slice(0, declarationOffset)}${bindings}${tail.slice(declarationOffset + declaration[0].length)}`
    }
    // Bare extension elements had no namespace before the root gained a default binding.
    const binding = usesDefault === inherited ? '' : ` xmlns="${usesDefault ? uri : ''}"`
    return `<${normalizedName}${binding}${tail}`
  })
}
