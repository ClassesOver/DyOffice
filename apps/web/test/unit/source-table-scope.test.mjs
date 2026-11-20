import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceConfig } from '../../server/src/modules/sources/config.ts'
import { validateReadOnlySql } from '../../server/src/modules/sources/sql-policy.ts'
import { querySqlSource } from '../../server/src/modules/sources/sql.ts'

test('SQL table configuration is bounded, deduplicated and rejects invalid/system names', () => {
 assert.deepEqual(sourceConfig('postgres', {allowedTables:['sales','sales','public.sales']}).allowedTables, ['sales','public.sales'])
 assert.deepEqual(sourceConfig('mysql', {allowedTables:[]}).allowedTables, [])
 assert.equal(sourceConfig('postgres', {}).allowedTables, undefined)
 for(const allowedTables of [null,'sales',[1],[''],[' a'],['a.b.c'],['a;drop'],['information_schema.tables'],['pg_catalog.pg_class'], Array(257).fill('sales')]) assert.throws(()=>sourceConfig('postgres',{allowedTables}))
 assert.throws(()=>sourceConfig('http',{allowedTables:[]}))
})

test('AST table scope checks joins, CTE bodies, nested queries and set branches', () => {
 for(const kind of ['postgres','mysql','starrocks']) {
  const scope={allowedTables:['sales'],defaultSchema:kind==='postgres'?'public':'warehouse'}
  for(const sql of ['SELECT 1', 'SELECT * FROM sales', 'WITH x AS (SELECT * FROM sales) SELECT * FROM x', 'WITH x AS (SELECT * FROM sales), y AS (SELECT * FROM x) SELECT * FROM y', 'SELECT * FROM (SELECT * FROM sales) s UNION ALL SELECT * FROM sales']) assert.equal(typeof validateReadOnlySql(sql,kind,scope),'string')
  for(const sql of ['SELECT * FROM hidden', 'SELECT * FROM sales JOIN hidden h ON 1=1', 'WITH x AS (SELECT * FROM hidden) SELECT * FROM x', 'SELECT * FROM sales WHERE id IN (SELECT id FROM hidden)', 'SELECT * FROM (SELECT * FROM hidden) s', 'SELECT * FROM sales UNION ALL SELECT * FROM hidden', 'WITH hidden AS (SELECT * FROM hidden) SELECT * FROM hidden', 'WITH x AS (SELECT * FROM hidden), hidden AS (SELECT 1) SELECT * FROM x', 'SELECT * FROM information_schema.tables', 'SELECT * FROM other.sales']) assert.throws(()=>validateReadOnlySql(sql,kind,scope),sql)
  assert.equal(typeof validateReadOnlySql('WITH x AS (SELECT 1 AS n) SELECT * FROM x',kind,{...scope,allowedTables:[]}),'string')
  assert.throws(()=>validateReadOnlySql('SELECT * FROM sales',kind,{...scope,allowedTables:[]}))
 }
})

test('table rejection happens before egress resolution', async () => {
 let called=false
 await assert.rejects(()=>querySqlSource({sql:async()=>{called=true;throw Error('network')}},'postgres','postgresql://u:p@localhost/db','SELECT * FROM hidden',{maxRows:10},{allowedTables:['sales'],defaultSchema:'public'}),e=>e.statusCode===400)
 assert.equal(called,false)
})


test('recursive CTE aliases are not physical tables, while three-part table names fail closed', () => {
 for(const kind of ['postgres','mysql','starrocks']) {
  const scope={allowedTables:[],defaultSchema:'public'}
  assert.equal(typeof validateReadOnlySql('WITH RECURSIVE x AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM x WHERE n<3) SELECT * FROM x',kind,scope),'string')
  assert.throws(()=>validateReadOnlySql('WITH RECURSIVE x AS (SELECT * FROM hidden UNION ALL SELECT * FROM x) SELECT * FROM x',kind,scope))
 }
 assert.throws(()=>validateReadOnlySql('SELECT * FROM other.private.sales','postgres',{allowedTables:['other.sales'],defaultSchema:'public'}))
})

test('schema scope limits every table reference and intersects an explicit table scope', () => {
 const config=sourceConfig('postgres',{allowedSchemas:['sales','sales']})
 assert.deepEqual(config.allowedSchemas,['sales'])
 for (const allowedSchemas of ['sales',['sales.*'],['pg_catalog'],['information_schema']]) {
  assert.throws(()=>sourceConfig('postgres',{allowedSchemas}))
 }
 const scope={defaultSchema:'public',allowedSchemas:['sales']}
 assert.doesNotThrow(()=>validateReadOnlySql('SELECT * FROM sales.orders','postgres',scope))
 assert.throws(()=>validateReadOnlySql('SELECT * FROM public.orders','postgres',scope))
 assert.throws(()=>validateReadOnlySql('SELECT * FROM sales.orders JOIN payroll.salaries ON true','postgres',scope))
 assert.throws(()=>validateReadOnlySql('SELECT * FROM sales.orders','postgres',{...scope,allowedSchemas:[]}))
 assert.throws(()=>validateReadOnlySql('SELECT * FROM sales.orders','postgres',{...scope,allowedTables:['sales.returns']}))
 assert.doesNotThrow(()=>validateReadOnlySql('SELECT * FROM sales.orders','postgres',{...scope,allowedTables:['sales.orders']}))
})
