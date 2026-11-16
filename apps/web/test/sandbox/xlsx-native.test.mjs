import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { sandboxFixture } from '../helpers/native-sandbox.mjs'

async function workbook() {
  const zip = await JSZip.loadAsync(await readFile(new URL('../../../shell/build/shell-new/blank.xlsx',import.meta.url)))
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  zip.file('xl/worksheets/sheet1.xml',xml.replace(/<sheetData(?:\s*\/>|>[\s\S]*?<\/sheetData>)/,'<sheetData><row r="1"><c r="A1"><v>37</v></c><c r="B1"><f>A1*2</f><v>0</v></c></row></sheetData>').replace(/<dimension[^>]*\/>/,'<dimension ref="A1:B1"/>'))
  zip.file('customXml/dyoffice-preserve.xml','<probe>Untouched original part</probe>')
  return zip.generateAsync({ type: 'nodebuffer' })
}
test('original locked Rust engine opens, reads and recalculates actual XLSX bytes inside isolation', { timeout: 30_000 },async () => {
  const sandbox = await sandboxFixture('native'), bytes = await workbook()
  await sandbox.run(bytes,async session => {
    const opened = await session.request('open',{ path: '/work/input.xlsx',locale: 'en' })
    assert.equal(opened.sheets.length,1)
    const cells = await session.request('read_range',{ sessionId: opened.sessionId,sheetId: opened.sheets[0].id,range: { startRow: 0,endRow: 0,startColumn: 0,endColumn: 1 } })
    assert.equal(cells.cells.find(cell => cell.column===0).value,37)
    const computed = await session.request('recalc_cells',{ path: '/work/input.xlsx',edits: [],reads: [{ sheet: opened.sheets[0].name,range: { startRow: 0,endRow: 0,startColumn: 1,endColumn: 1 } }] })
    assert.equal(computed.cells.find(cell => cell.column===1).number,74)
    await session.request('close',{ sessionId: opened.sessionId })
  })
})
test('native save/reopen returns real output bytes with every original XML part preserved', { timeout: 30_000 },async () => {
  const { createXlsxNativeWorker } = await import('../../worker/src/native/xlsx.ts')
  const input = await workbook(), sandbox = await sandboxFixture('native')
  const result = await createXlsxNativeWorker(sandbox).roundtrip(input)
  assert.equal(result.sheetCount,1)
  const before = await JSZip.loadAsync(input,{ checkCRC32: true }), after = await JSZip.loadAsync(result.bytes,{ checkCRC32: true })
  const parts = zip => Object.keys(zip.files).filter(name => !zip.files[name].dir).sort()
  assert.deepEqual(parts(after),parts(before))
  for (const name of parts(before)) assert.deepEqual(await after.file(name).async('nodebuffer'),await before.file(name).async('nodebuffer'),name)
  await assert.rejects(() => createXlsxNativeWorker(sandbox).roundtrip(Buffer.from('not a workbook')),{ code: 'NATIVE_FAILED' })
})
