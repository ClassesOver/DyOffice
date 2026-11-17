import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceGrantQuery, validateSourceGrantRows } from '../../server/src/modules/sources/grants.ts'

const fields = ['UserIdentity', 'Catalog', 'Grants'].map(name => ({ name }))
const reader = "'reader'@'%'"
const allowed = `GRANT SELECT ON TABLE rj.* TO USER ${reader}`

test('StarRocks uses its native SHOW GRANTS form and the named Grants column', () => {
  assert.equal(sourceGrantQuery('starrocks'), 'SHOW GRANTS')
  assert.equal(sourceGrantQuery('mysql'), 'SHOW GRANTS FOR CURRENT_USER()')
  assert.doesNotThrow(() => validateSourceGrantRows('starrocks', [[reader, 'default', allowed]], fields, 'rj'))
  assert.doesNotThrow(() => validateSourceGrantRows('starrocks', [[allowed, reader, 'default_catalog']], [{name:'Grants'}, {name:'UserIdentity'}, {name:'Catalog'}], 'rj'))
})

test('StarRocks SELECT supports only explicitly scoped internal tables or views', () => {
  for (const statement of [
    `GRANT SELECT ON TABLE \`rj\`.\`sales\` TO USER ${reader};`,
    `GRANT SELECT ON VIEW \`default_catalog\`.\`rj\`.\`approved_view\` TO USER ${reader}`,
  ]) assert.doesNotThrow(() => validateSourceGrantRows('starrocks', [[reader, 'default', statement]], fields, 'rj'))
  assert.doesNotThrow(() => validateSourceGrantRows('starrocks', [
    [reader, 'default', `GRANT USAGE ON CATALOG default_catalog TO USER ${reader}`],
    [reader, 'default', allowed],
  ], fields, 'rj'))
})

test('root, role inheritance, writes, other databases and catalog-wide privileges fail closed', () => {
  const rejected = [
    ["'root'@'%'", null, "GRANT 'root' TO 'root'@'%'"],
    [reader, null, `GRANT 'reporting_role' TO ${reader}`],
    [reader, 'default', `GRANT SELECT, INSERT ON TABLE rj.* TO USER ${reader}`],
    [reader, 'default', `GRANT SELECT ON TABLE other.* TO USER ${reader}`],
    [reader, 'default', `GRANT SELECT ON TABLE *.* TO USER ${reader}`],
    [reader, 'default', `${allowed} WITH GRANT OPTION`],
    [reader, 'external', allowed],
    [reader, 'default', `GRANT SELECT ON TABLE external.rj.sales TO USER ${reader}`],
    [reader, 'default', `GRANT CREATE_TABLE ON DATABASE rj TO USER ${reader}`],
    [reader, 'default', allowed + '; GRANT ALL ON TABLE rj.* TO USER ' + reader],
  ]
  for (const row of rejected) assert.throws(() => validateSourceGrantRows('starrocks', [row], fields, 'rj'), { statusCode: 403 })
  assert.throws(() => validateSourceGrantRows('starrocks', [[reader,'default',allowed], rejected[0]], fields, 'rj'), {statusCode:403})
})

test('malformed grant metadata and the old first-column interpretation are rejected', () => {
  for (const [rows, columns] of [
    [[[reader,'default',allowed]], [{name:'UserIdentity'},{name:'Catalog'},{name:'Privileges'}]],
    [[[reader,'default',allowed]], [{name:'Grants'},{name:'Grants'},{name:'Catalog'}]],
    [[[allowed]], [{name:'Grants'}]],
    [[], fields],
    [[[reader,'default',null]], fields],
  ]) assert.throws(() => validateSourceGrantRows('starrocks', rows, columns, 'rj'), {statusCode:403})
})

test('the MySQL grant path keeps its existing narrow SELECT validation', () => {
  assert.doesNotThrow(() => validateSourceGrantRows('mysql', [[`GRANT SELECT ON \`rj\`.* TO ${reader}`]], [{name:'Grants for reader@%'}], 'rj'))
  assert.throws(() => validateSourceGrantRows('mysql', [[`GRANT ALL PRIVILEGES ON *.* TO ${reader}`]], [{name:'Grants for reader@%'}], 'rj'), {statusCode:403})
})
