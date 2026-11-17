import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
test('analysis guidance explicitly preserves scope/units/timezone and forbids silent expired-input substitution',async()=>{
 const source=await readFile(new URL('../../server/src/modules/coding/harness.ts',import.meta.url),'utf8')
 assert.match(source,/Check truncated, row count, column units and timezone/)
 assert.match(source,/Never infer full-dataset totals or completeness from truncated inputs/)
 assert.match(source,/report input expired; do not silently requery and replace it/)
 assert.match(source,/separately authorized bounded aggregate query/)
})
