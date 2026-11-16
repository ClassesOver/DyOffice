import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectTools, classifyTools, checkInventory } from './agent-tool-inventory.mjs'

test('AST discovers literal and local constant tool names, excluding comments and unrelated names', () => {
  const rows = inspectTools(`// {name:'fake', inputSchema:{}}
const NAME='real'; const t={name:NAME,inputSchema:{type:'object'}};
const unrelated={name:'filename'};`, 'fixture.ts')
  assert.deepEqual(rows.map(r=>r.name), ['real'])
  assert.match(rows[0].schemaSha256, /^[a-f0-9]{64}$/)
})
test('unresolved names, spreads, malformed syntax and duplicate identities fail closed', () => {
  for (const source of ["const x={name:dynamic,inputSchema:{}}", "const x={...base,name:'x',inputSchema:{}}", "const x={inputSchema:{}}", "const x=", "const a={name:'x',inputSchema:{}}; const b={name:'x',inputSchema:{}};"]) {
    assert.throws(()=>inspectTools(source,'fixture.ts'))
  }
})
test('every definition requires an explicit reviewed placement and stale rows fail', () => {
  const rows=inspectTools("const x={name:'a',inputSchema:{}}",'fixture.ts')
  const row={id:'fixture.ts#a',placement:'live',web:'Active editor command dispatcher',verifyIn:'T14',rationale:'Requires the active document state'}
  assert.equal(classifyTools(rows,{schema:1,tools:[row]}).length,1)
  assert.throws(()=>classifyTools(rows,{schema:1,tools:[]}))
  assert.throws(()=>classifyTools([],{schema:1,tools:[row]}))
  assert.throws(()=>classifyTools(rows,{schema:1,tools:[row,row]}))
  assert.throws(()=>classifyTools(rows,{schema:1,tools:[{...row,placement:'available'}]}))
  assert.throws(()=>classifyTools(rows,{schema:1,tools:[{...row,verifyIn:'complete'}]}))
})
test('schema changes are visible in the inventory fingerprint', () => {
  const before=inspectTools("const x={name:'a',inputSchema:{type:'string'}}",'fixture.ts')
  const after=inspectTools("const x={name:'a',inputSchema:{type:'number'}}",'fixture.ts')
  assert.notEqual(before[0].schemaSha256,after[0].schemaSha256)
})
test('repository tool definitions and reviewed generated inventory remain in sync', async () => {
  assert.equal((await checkInventory()).count,151)
})

test('shadowed or mutable tool-name bindings fail closed and shorthand schemas are inventoried', () => {
  for (const source of ["const NAME='outer'; const f=function NAME(){return {name:NAME,inputSchema:{}}}", "const NAME='outer'; const C=class NAME { t={name:NAME,inputSchema:{}} }", "const NAME='outer'; function f(NAME){return {name:NAME,inputSchema:{}}}", "let NAME='old'; NAME=runtime; const t={name:NAME,inputSchema:{}}", "const NAME='old'; NAME=runtime; const t={name:NAME,inputSchema:{}}"])
    assert.throws(()=>inspectTools(source,'fixture.ts'))
  const rows=inspectTools("const inputSchema={}; const t={name:'found',inputSchema};",'fixture.ts')
  assert.deepEqual(rows.map(r=>r.name),['found'])
})

test('classification cannot override extracted source evidence', () => {
  const rows=inspectTools("const x={name:'a',inputSchema:{}}",'fixture.ts')
  const rule={id:'fixture.ts#a',placement:'live',web:'Editor',verifyIn:'T14',rationale:'State',name:'fake',sourceSha256:'fake',schemaSha256:'fake',file:'fake',line:0}
  const result=classifyTools(rows,{schema:1,tools:[rule]})[0]
  for(const field of ['name','file','line','sourceSha256','schemaSha256']) assert.equal(result[field],rows[0][field])
})
test('static computed tool properties are inventoried', () => {
  assert.throws(()=>inspectTools("const t={name:'a',[schemaKey]:{}}",'fixture.ts'))
  assert.throws(()=>inspectTools("const NAME='outer'; import * as NAME from 'x'; const t={name:NAME,inputSchema:{}}",'fixture.ts'))
  assert.equal(inspectTools("const t={['name']:'a',['inputSchema']:{}}",'fixture.ts')[0]?.name,'a')
})
