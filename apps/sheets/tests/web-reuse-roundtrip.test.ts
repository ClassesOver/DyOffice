import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { applyCellEditsToXlsx, writeXlsxAtomically, mutateXlsxFile, sha256 } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'
import { buildEditFixture } from './fixture-builder'

// Engine reuse spike only: no Web route, browser UI, Rust recalc or production CAS claim.
describe('original XLSX gateway reuse without Electron', () => {
  it('writes a real workbook, reopens it and preserves untouched package parts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-reuse-'))
    try {
      const path = join(dir, 'saved.xlsx')
      const source = await buildEditFixture()
      const before = await JSZip.loadAsync(source)
      const mutation = await applyCellEditsToXlsx(source, [
        { sheetName: 'Data', row: 0, column: 0, writeValue: true, cell: { value: 'DyOffice 原生写回' } },
        { sheetName: 'Data', row: 1, column: 2, writeValue: true, cell: { value: 37 } },
      ])
      await writeXlsxAtomically(path, mutation.buffer)
      const saved = await readFile(path)
      expect(sha256(saved)).not.toBe(sha256(source))
      const reopened = await JSZip.loadAsync(saved, { checkCRC32: true })
      const sheet = await reopened.file('xl/worksheets/sheet1.xml')!.async('string')
      expect(sheet).toContain('DyOffice 原生写回')
      expect(sheet).toMatch(/<c r="C2"[^>]*><v>37<\/v><\/c>/)
      expect(sheet).toContain('<f>SUM(C1:C2)</f>')
      for (const part of ['customXml/item1.xml', 'xl/charts/chart1.xml', 'xl/styles.xml', 'xl/sharedStrings.xml']) {
        expect(await reopened.file(part)!.async('nodebuffer')).toEqual(await before.file(part)!.async('nodebuffer'))
      }
      // Reuse the original mutation engine again on bytes reopened from disk.
      const second = await applyCellEditsToXlsx(saved, [
        { sheetName: 'Data', row: 1, column: 2, writeValue: true, cell: { value: 42 } },
      ])
      await writeXlsxAtomically(path, second.buffer)
      const again = await JSZip.loadAsync(await readFile(path), { checkCRC32: true })
      expect(await again.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<v>42</v>')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects an already stale file digest without changing stored bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-conflict-'))
    try {
      const path = join(dir, 'saved.xlsx')
      const source = await buildEditFixture()
      await writeFile(path, source)
      await expect(mutateXlsxFile(path, '0'.repeat(64), {
        transactionId: 'spike', baseRevision: 0, cellChanges: [], sheetRenames: [], structuralChanges: [], formatChanges: [], warnings: [],
      }, { 'sheet-1': 'Data' })).rejects.toThrow('changed on disk')
      expect(await readFile(path)).toEqual(source)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
