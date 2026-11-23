import test from 'node:test'
import assert from 'node:assert/strict'
import { harnessSourceCatalog } from '../../server/src/modules/coding/source-catalog.ts'
import { HARNESS_DATA_MAX_METADATA_BYTES } from '../../../../packages/web-contracts/src/harness-data.ts'

test('Codex catalog byte limits count UTF-8 units and continue at the first undisplayed column', () => {
  const tables = Array.from({ length: 10 }, (_, i) => `measurements_${i}`)
  const columns = Array.from({ length: 100 }, (_, i) => `metric_${i}`)
  const unit = '元'.repeat(95)
  const units = Object.fromEntries(columns.map(name => [name, unit]))
  const rows = tables.flatMap(table_name => columns.map(column_name => ({ table_schema: 'public', table_name, column_name, data_type: 'integer', is_nullable: 'YES' })))
  const describe = columnOffset => harnessSourceCatalog({
    kind: 'postgres', sourceId: 'metrics', sourceVersion: 1, config: { timezone: 'UTC', units },
    metadata: { rows: rows.slice(columnOffset), truncated: false, nextOffset: null },
  }, { tables, columnOffset })
  const first = describe(0)
  assert.equal(first.truncated, true)
  assert.ok(first.nextOffset > 0 && first.nextOffset < rows.length)
  const second = describe(first.nextOffset)
  assert.equal(second.nextOffset, null)
  assert.equal(second.truncated, false)
  const keys = []
  for (const page of [first, second]) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= HARNESS_DATA_MAX_METADATA_BYTES)
    for (const table of page.tables) for (const column of table.columns) {
      assert.equal(column.unit, unit)
      keys.push([table.name, column.name])
    }
  }
  assert.deepEqual(keys, rows.map(row => [row.table_name, row.column_name]))
})
