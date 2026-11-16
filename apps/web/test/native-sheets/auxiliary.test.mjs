import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
test('isolated formula and outline reads resolve sheets from the captured workbook',async()=>{
 const native=createXlsxNativeWorker(await sandboxFixture('native')),bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const formulas=await native.readSheet(bytes,'Acceptance','formulas')
 assert.equal(formulas.cells.find(cell=>cell.row===1&&cell.column===1).formula,'=A2*2')
 assert.equal(formulas.cells.find(cell=>cell.row===1&&cell.column===1).value,999)
 const outline=await native.readSheet(bytes,'Acceptance','outline')
 assert.equal(outline.indexingComplete,true)
 await assert.rejects(()=>native.readSheet(bytes,'Unknown','formulas'),{code:'UNKNOWN_SHEET'})
 await assert.rejects(()=>native.readSheet(bytes,'Acceptance','save_archive'),{code:'UNSUPPORTED_COMMAND'})
})

test('isolated recalculation replaces stale caches and applies pending edits by sheet name',async()=>{
 const native=createXlsxNativeWorker(await sandboxFixture('native')),bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const reads=[{sheetName:'Acceptance',range:{startRow:1,endRow:1,startColumn:1,endColumn:1}}]
 assert.equal((await native.recalculate(bytes,{edits:[],reads})).cells[0].number,25)
 assert.equal((await native.recalculate(bytes,{edits:[{sheetName:'Acceptance',row:1,column:0,input:'30'}],reads})).cells[0].number,60)
 await assert.rejects(()=>native.recalculate(bytes,{edits:[],reads:[{...reads[0],sheetName:'Missing'}]}),{code:'UNKNOWN_SHEET'})
 await assert.rejects(()=>native.recalculate(bytes,{edits:[],reads:[{...reads[0],range:{startRow:0,endRow:100000,startColumn:0,endColumn:100}}]}),{code:'INPUT_LIMIT'})
})
