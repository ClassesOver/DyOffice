import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'

test('Sheets API startup cannot load a package parser into the API process', async()=>{
  const source=await readFile(new URL('../../server/src/modules/sheets/runtime.ts',import.meta.url),'utf8')
  assert.doesNotMatch(source,/await\s+import\s*\(/)
  assert.match(source,/createGatewayAdapter\(tracked\(gatewaySandbox\)\)/)
  assert.match(source,/await gatewaySandbox\.run\(/)
})

test('Sheets isolation remains opt-in and cannot be enabled in production', async()=>{
  assert.equal(await configuredSheetsRuntime({}),undefined)
  await assert.rejects(()=>configuredSheetsRuntime({DYOFFICE_NATIVE_XLSX:'experimental',DYOFFICE_AUTH_MODE:'local',NODE_ENV:'production'}),/requires experimental local mode/)
  await assert.rejects(()=>configuredSheetsRuntime({DYOFFICE_NATIVE_XLSX:'experimental',DYOFFICE_AUTH_MODE:'development'}),/requires experimental local mode/)
})
