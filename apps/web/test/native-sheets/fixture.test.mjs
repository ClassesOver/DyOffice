import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import JSZip from 'jszip'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
test('T09 fixture hashes are fixed and original Rust reads its numeric cells and stale formula cache',async()=>{
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)),meta=JSON.parse(await readFile(new URL('../fixtures/sheets/acceptance.json',import.meta.url),'utf8'))
 assert.equal(createHash('sha256').update(bytes).digest('hex'),meta.sha256)
 const zip=await JSZip.loadAsync(bytes,{checkCRC32:true})
 for(const [name,hash] of Object.entries(meta.parts))assert.equal(createHash('sha256').update(await zip.file(name).async('nodebuffer')).digest('hex'),hash,name)
 const runner=await sandboxFixture('native')
 await runner.run(bytes,async session=>{
  const opened=await session.request('open',{path:'/work/input.xlsx',locale:'en'})
  assert.equal(opened.sheets[0].name,'Acceptance')
  const result=await session.request('read_range',{sessionId:opened.sessionId,sheetId:opened.sheets[0].id,range:{startRow:1,endRow:1,startColumn:0,endColumn:5}})
  assert.equal(result.cells.find(cell=>cell.column===0).value,12.5)
  assert.equal(result.cells.find(cell=>cell.column===3).value,0.125)
  assert.equal(result.cells.find(cell=>cell.column===4).value,1234.567)
  const calculated=await session.request('recalc_cells',{path:'/work/input.xlsx',edits:[],reads:[{sheet:'Acceptance',range:{startRow:1,endRow:1,startColumn:1,endColumn:1}}]})
  assert.equal(calculated.cells.find(cell=>cell.column===1).number,25)
  await session.request('close',{sessionId:opened.sessionId})
 })
})
