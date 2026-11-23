import test from 'node:test'
import assert from 'node:assert/strict'
import { dbhubConfig, dbhubDsn, statementsToRows } from '../../server/src/modules/sources/dbhub.ts'

test('DBHub is configured as the default read-only executor', () => {
  const config = dbhubConfig(100, 5000)
  assert.match(config, /name = "execute_sql"/)
  assert.match(config, /readonly = true/)
  assert.match(config, /max_rows = 101/)
  assert.match(config, /query_timeout = 5/)
  assert.match(config, /DYOFFICE_DBHUB_DSN/)
})

test('StarRocks uses DBHub MySQL protocol without exposing credentials in logs', () => {
  const dsn = dbhubDsn('starrocks', { address: '10.0.0.4', port: 9030, username: 'root', password: 's@cret', database: 'rj', tls: false })
  assert.equal(dsn, 'mysql://root:s%40cret@10.0.0.4:9030/rj?ssl-mode=DISABLED')
})

test('DBHub statement payload preserves object row names and scalar types', () => {
  const rows = statementsToRows({ statements: [{ rows: [{ name: 'Ada', count: 2, enabled: true }] }] })
  assert.deepEqual(rows, { names: ['name', 'count', 'enabled'], rows: [['Ada', 2, true]], types: ['string', 'number', 'boolean'] })
})

test('DBHub array rows receive stable column names', () => {
  const rows = statementsToRows({ statements: [{ rows: [[1, null], [2, 'x']] }] })
  assert.deepEqual(rows, { names: ['column_1', 'column_2'], rows: [[1, null], [2, 'x']], types: ['number', 'string'] })
})

test('StarRocks rejects writes and out-of-scope reads before DBHub connects', async () => {
  const { queryDbhubSource } = await import('../../server/src/modules/sources/dbhub.ts')
  const policy = { sql: () => assert.fail('must reject before egress') }
  for (const sql of ['DELETE FROM orders', 'SELECT * FROM private_table']) {
    await assert.rejects(queryDbhubSource(policy, 'starrocks', '', sql, {maxRows: 2}, {defaultSchema: 'sales', allowedTables: ['sales.orders']}), e => [400,403].includes(e.statusCode))
  }
})
