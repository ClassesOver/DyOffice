import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import JSZip from 'jszip'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
test('original gateway plans real edits and isolated Rust preserves unrelated workbook parts',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-gateway-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 const module=join(directory,'gateway.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:module,banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},logLevel:'silent'})
 const gateway=await import(pathToFileURL(module).href)
 const input=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const plan=await gateway.planCellEditsToXlsx(await gateway.createBufferEntrySource(input),[
  {sheetName:'Acceptance',row:1,column:0,writeValue:true,cell:{value:21.25}},
  {sheetName:'Acceptance',row:1,column:1,writeValue:true,cell:{value:null,formula:'=A2*3'}},
 ])
 const result=await createXlsxNativeWorker(await sandboxFixture('native')).savePlan(input,plan)
 const before=await JSZip.loadAsync(input),after=await JSZip.loadAsync(result.bytes,{checkCRC32:true})
 const sheet=await after.file('xl/worksheets/sheet1.xml').async('string')
 assert.match(sheet,/<v>21\.25<\/v>/);assert.match(sheet,/<f[^>]*>A2\*3<\/f>/)
 for(const name of Object.keys(before.files).filter(name=>!before.files[name].dir&&!plan.touchedEntries.includes(name)&&!plan.removedEntries.includes(name)))assert.deepEqual(await after.file(name).async('nodebuffer'),await before.file(name).async('nodebuffer'),name)
 const runner=await sandboxFixture('native')
 await runner.run(result.bytes,async session=>{
  const computed=await session.request('recalc_cells',{path:'/work/input.xlsx',edits:[],reads:[{sheet:'Acceptance',range:{startRow:1,endRow:1,startColumn:1,endColumn:1}}]})
  assert.equal(computed.cells.find(cell=>cell.column===1).number,63.75)
 })
})
