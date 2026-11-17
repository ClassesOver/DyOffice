import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {databaseCleanupError} from '../helpers/database-cleanup-diagnostics.mjs'

test('cleanup diagnostic query is scoped, read-only, bounded and excludes SQL and secrets',async()=>{
 let query,values
 const rows=[{pid:123,backend_type:'client backend',application:'source-reader',state:'idle in transaction',wait_event_type:'Client',wait_event:'ClientRead',backend_age_seconds:8,transaction_age_seconds:4,state_age_seconds:3}]
 const error=await databaseCleanupError({query:async(config)=>{query=config.text;values=config.values;assert.equal(config.query_timeout,1000);return {rows}}},'fixture-db')
 assert.match(query,/^SELECT /)
 assert.match(query,/WHERE datname=\$1 ORDER BY pid LIMIT 20$/)
 assert.doesNotMatch(query,/\b(?:query|usename|client_addr|client_hostname|datname\s*,|pg_terminate_backend|pg_cancel_backend)\b/)
 assert.match(query,/ELSE 'other' END AS application/)
 assert.deepEqual(values,['fixture-db'])
 assert.equal(error.message,'Test database still has open connections after pool shutdown; backends='+JSON.stringify(rows))
 assert.equal(error.message.includes('fixture-db'),false)
})
test('diagnostic errors retain original failure and never expose the underlying error',async()=>{
 const error=await databaseCleanupError({query:async()=>{throw Error('secret-connection-string')}},'private-db')
 assert.equal(error.message,'Test database still has open connections after pool shutdown; backends=[{"diagnostic":"unavailable"}]')
})

test('fixture keeps the same cleanup deadline and consults diagnostics only on failure',async()=>{
 const source=await readFile(new URL('../helpers/restricted.mjs',import.meta.url),'utf8')
 assert.match(source,/const deadline = Date.now\(\) \+ 4000/)
 assert.match(source,/if \(Date.now\(\) >= deadline\) throw await databaseCleanupError\(admin, database\)/)
 assert.doesNotMatch(source,/pg_terminate_backend|pg_cancel_backend/)
})
