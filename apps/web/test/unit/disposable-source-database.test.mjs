import {test} from 'node:test'
import assert from 'node:assert/strict'
import {assertDisposableSourceDatabase} from '../helpers/disposable-source-database.mjs'
const url=port=>`postgresql://postgres:dyoffice-ci-test-only@127.0.0.1:${port}/dyoffice_test`
test('accepts only the designated CI and local disposable PostgreSQL endpoints',()=>{
 for(const port of [55432,55433])assert.doesNotThrow(()=>assertDisposableSourceDatabase(url(port)))
})
test('rejects remote, production, ambiguous and credential-overridden targets',()=>{
 for(const value of [undefined,'',url(5432),url(55434),url(55433).replace('127.0.0.1','production.example'),url(55433).replace('dyoffice_test','production'),url(55433).replace('/dyoffice_test','/dyoffice_test_other'),url(55433).replace('postgresql:','https:'),url(55433).replace('postgres:','admin:'),url(55433).replace('dyoffice-ci-test-only','real-secret'),url(55433)+'?host=production.example',url(55433)+'#ignored',url(55433).replace('127.0.0.1','127.1'),url(55433).replace('127.0.0.1','localhost')])assert.throws(()=>assertDisposableSourceDatabase(value),/designated disposable/)
})
