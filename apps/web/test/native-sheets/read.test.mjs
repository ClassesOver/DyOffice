import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
test('native read adapter reopens captured bytes and resolves sheet names inside each isolated call',async()=>{
 const native=createXlsxNativeWorker(await sandboxFixture('native')),input=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const workbook=await native.inspect(input)
 assert.equal(workbook.sheets[0].name,'Acceptance');assert.equal(Object.hasOwn(workbook,'sessionId'),false)
 const range={startRow:1,endRow:1,startColumn:0,endColumn:5}
 for(let i=0;i<2;i++){
  const result=await native.readRange(input,'Acceptance',range)
  assert.equal(result.cells.find(c=>c.column===0).value,12.5)
 }
 await assert.rejects(()=>native.readRange(input,'Missing',range),{code:'UNKNOWN_SHEET'})
 await assert.rejects(()=>native.readRange(input,'Acceptance',{...range,endRow:1000000}),{code:'INPUT_LIMIT'})
})
