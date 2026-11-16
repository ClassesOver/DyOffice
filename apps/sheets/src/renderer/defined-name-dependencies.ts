import { LexerTreeBuilder } from '@univerjs/engine-formula'

interface NameContext {
  unitId: string | null
  getValueByName(unit: string, name: string): unknown
  getDirtyDefinedNameMap(): Record<string, Record<string, unknown>>
}
interface NameResult {
  hasDefinedName: boolean
  definedNames: string[]
  sequenceString: string
}
interface Token {
  nodeType: number
  token: string
}
interface Parser {
  treeBuilder(formula: string, transform?: boolean, context?: NameContext): unknown
  _simpleCheckDefinedName(formula: string, context: NameContext): boolean
  _handleDefinedName(sequence: unknown[], context: NameContext): NameResult
  getSequenceNode(sequence: unknown[]): (string | Token)[]
  _getHasSheetNameDefinedName(token: string, unit: string, context: NameContext): string
}
let installed = false
/** Univer expands a named range by recursively parsing its definition. For a
 * plain range that recursive result has no names, and the outer name is lost
 * from dependency metadata. Keep the direct name as well as nested names so
 * changing the definition invalidates existing formula trees. */
export function installDefinedNameDependencies(): void {
  if (installed) return
  const prototype = LexerTreeBuilder.prototype as unknown as Parser
  const originalTree = prototype.treeBuilder,
    originalCheck = prototype._simpleCheckDefinedName
  const original = prototype._handleDefinedName
  if ([originalTree, originalCheck, original, prototype.getSequenceNode, prototype._getHasSheetNameDefinedName].some(method => typeof method !== 'function')) throw new Error('Unsupported defined name parser')
  const dependencies = new WeakMap<Parser, Map<string, string[]>>()
  prototype.treeBuilder = function (formula, transform, context) {
    const node = originalTree.call(this, formula, transform, context) as {
      getDefinedNames?: () => string[]
    }
    if (context) {
      let map = dependencies.get(this)
      if (!map) {
        map = new Map()
        dependencies.set(this, map)
      }
      if (map.size > 5000) map.clear()
      map.set(`${context.unitId}\0${formula}`, [...(node?.getDefinedNames?.() ?? [])])
    }
    return node
  }
  prototype._simpleCheckDefinedName = function (formula, context) {
    if (originalCheck.call(this, formula, context)) return true
    const dirty = context.unitId ? context.getDirtyDefinedNameMap()[context.unitId] : undefined
    return (
      !!dirty &&
      (dependencies.get(this)?.get(`${context.unitId}\0${formula}`) ?? []).some((name) =>
        Object.hasOwn(dirty, name),
      )
    )
  }
  prototype._handleDefinedName = function (sequence, context) {
    if (!context.unitId) return original.call(this, sequence, context)
    const names = new Set<string>()
    for (const node of this.getSequenceNode(sequence)) {
      if (typeof node === 'string' || (node.nodeType !== 3 && node.nodeType !== 4)) continue
      const name =
        node.nodeType === 3
          ? this._getHasSheetNameDefinedName(node.token, context.unitId, context)
          : node.token
      if (context.getValueByName(context.unitId, name)) names.add(name)
    }
    const result = original.call(this, sequence, context)
    for (const name of result.definedNames) names.add(name)
    return { ...result, definedNames: [...names] }
  }
  installed = true
}
