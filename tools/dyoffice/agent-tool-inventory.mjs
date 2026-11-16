// Source-level T00 inventory, never a runtime capability/authorization registry.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const ts = require('typescript')
const root = fileURLToPath(new URL('../../', import.meta.url))
export const ROOTS = ['apps/docs/src/renderer/ai', 'apps/sheets/src/renderer/ai', 'apps/slides/src/renderer/ai', 'apps/pdf/src/renderer/ai', 'packages/agent-core/src', 'apps/shell/src/main/mcp/tools']
const REGISTRY='docs/dyoffice/inventory/agent-tools.json'
const DOCUMENT='docs/dyoffice/inventory/agent-tools.md'
const hash = value => createHash('sha256').update(value).digest('hex')
const key = node => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : ts.isComputedPropertyName(node) && ts.isStringLiteral(node.expression) ? node.expression.text : null

export function inspectTools(source, file) {
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true)
  if(ast.parseDiagnostics.length) throw new Error('Cannot parse '+file)
  const constants=new Map(), bindings=new Map(), assigned=new Set(), rows=[]
  function collect(node) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) && node.name && ts.isIdentifier(node.name)) {
      bindings.set(node.name.text,(bindings.get(node.name.text)??0)+1)
    }
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&ts.isStringLiteral(node.initializer)&&
      ts.isVariableDeclarationList(node.parent)&&(node.parent.flags & ts.NodeFlags.Const)&&
      ts.isVariableStatement(node.parent.parent)&&ts.isSourceFile(node.parent.parent.parent)) {
      constants.set(node.name.text,node.initializer.text)
    }
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&ts.isIdentifier(node.left)) assigned.add(node.left.text)
    if((ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))&&ts.isIdentifier(node.operand)&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(node.operator)) assigned.add(node.operand.text)
    ts.forEachChild(node,collect)
  }
  collect(ast)
  function visit(node) {
    if(ts.isObjectLiteralExpression(node)) {
      const properties=new Map(node.properties.filter(p=>p.name).map(p=>[key(p.name),ts.isPropertyAssignment(p)?p.initializer:ts.isShorthandPropertyAssignment(p)?p.name:null]))
      if(properties.has('name') && node.properties.some(p => p.name && ts.isComputedPropertyName(p.name) && key(p.name) === null)) throw new Error('Unresolved computed tool property in '+file)
      if(properties.has('inputSchema')) {
        const n=properties.get('name')
        const name=n&&(ts.isStringLiteral(n)?n.text:ts.isIdentifier(n)&&bindings.get(n.text)===1&&!assigned.has(n.text)?constants.get(n.text):null)
        if(!name || !properties.get('inputSchema') || node.properties.some(ts.isSpreadAssignment)) throw new Error('Unresolved tool definition in '+file)
        rows.push({id:file+'#'+name,name,file,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,
          schemaSha256:hash(properties.get('inputSchema').getText(ast)),sourceSha256:hash(source)})
      }
    }
    ts.forEachChild(node,visit)
  }
  visit(ast)
  if(new Set(rows.map(r=>r.id)).size!==rows.length) throw new Error('Duplicate tool identity in '+file)
  return rows
}
async function sources(base, directory) {
  const out=[]
  for(const entry of (await readdir(join(base,directory),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=directory+'/'+entry.name
    if(entry.isDirectory()) out.push(...await sources(base,path))
    else if(/\.[cm]?tsx?$/.test(path)) out.push(path)
  }
  return out
}
export async function inventory(base=root) {
  const rows=[]
  for(const directory of ROOTS) for(const path of await sources(base,directory)) rows.push(...inspectTools(await readFile(join(base,path),'utf8'),path))
  return rows.sort((a,b)=>a.id.localeCompare(b.id))
}
export function classifyTools(rows, spec) {
  if(spec?.schema!==1 || !Array.isArray(spec.tools)) throw new Error('Invalid tool registry')
  const map=new Map()
  for(const rule of spec.tools) {
    if(map.has(rule.id)||!['live','headless','unsupported'].includes(rule.placement)||!/^T\d{2}$/.test(rule.verifyIn)||!rule.web||!rule.rationale) throw new Error('Invalid/duplicate tool classification: '+rule.id)
    map.set(rule.id,rule)
  }
  const result=rows.map(row=>{
    const rule=map.get(row.id)
    if(!rule) throw new Error('Unclassified tool: '+row.id)
    map.delete(row.id)
    return {...row,placement:rule.placement,web:rule.web,verifyIn:rule.verifyIn,rationale:rule.rationale}
  })
  if(map.size) throw new Error('Stale classification: '+[...map.keys()].join(', '))
  return result
}
const cell=value=>String(value).replaceAll('|','\\|').replaceAll('\n',' ').replaceAll('`',"'")
export function renderInventory(rows) {
  const lines=['# T00 tool execution-placement inventory','',
    'This is a reviewed **proposed execution placement**, not a Web capability registry or proof that a tool works. All rows still require their listed task acceptance. `live` needs an authorized active editor; `headless` needs an authorized service/isolated worker; `unsupported` must fail explicitly rather than expose a desktop-only facility.', '',
    'Scope: explicit `name` + `inputSchema` tool-definition objects in all four renderer AI directories, shared agent-core and desktop MCP tool modules. Only unshadowed, unassigned top-level literal const bindings are resolved; shorthand schemas remain inventoried. Unknown names, spreads in definitions, syntax errors, missing or stale classifications fail closed. This inventories declarations, not dynamic registration, schema dependencies, runtime calls, tool availability or approval policy. Keep the separate host IPC inventory for call sites/lifecycle.', '',
    'Reproduce: `node tools/dyoffice/agent-tool-inventory.mjs --check`. Intentionally refresh source/schema fingerprints with `--write` only after review. A new or removed tool requires an explicit JSON classification edit.', '',
    `Definitions: ${rows.length}; live: ${rows.filter(r=>r.placement==='live').length}; headless: ${rows.filter(r=>r.placement==='headless').length}; unsupported: ${rows.filter(r=>r.placement==='unsupported').length}.`, '',
    '| Definition / source line | Placement | Web execution seam | Verify in | Schema SHA-256 / source SHA-256 | Reason |','| --- | --- | --- | --- | --- | --- |']
  for(const r of rows) lines.push(`| \`${cell(r.id)}:${r.line}\` | ${r.placement} | ${cell(r.web)} | ${r.verifyIn} | \`${r.schemaSha256}\` / \`${r.sourceSha256}\` | ${cell(r.rationale)} |`)
  return lines.join('\n')+'\n'
}
export async function checkInventory(base=root,{write=false}={}) {
  const rows=classifyTools(await inventory(base),JSON.parse(await readFile(join(base,REGISTRY),'utf8')))
  const generated=renderInventory(rows)
  if(write) await writeFile(join(base,DOCUMENT),generated)
  else if(await readFile(join(base,DOCUMENT),'utf8')!==generated) throw new Error('Tool inventory drift; review definitions/classification before --write')
  return {count:rows.length}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(!['--check','--write'].includes(process.argv[2])) throw new Error('Usage: agent-tool-inventory.mjs --check|--write')
    const r=await checkInventory(root,{write:process.argv[2]==='--write'})
    console.log(`agent-tools: ${r.count} classified definitions; runtime acceptance not implied`)
  } catch(error) { console.error(error.message); process.exitCode=1 }
}
