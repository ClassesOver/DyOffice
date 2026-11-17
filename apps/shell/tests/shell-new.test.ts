import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx } from '@genoffice/docx-engine'
import { openPptx } from '@genoffice/pptx-engine'

function template(ext: string): Buffer {
  return readFileSync(resolve(import.meta.dirname, '../build/shell-new', `blank.${ext}`))
}

describe('Shared empty Office templates', () => {
  it('opens the shared Word template as one empty paragraph', async () => {
    const doc = await parseDocx(template('docx'))
    const visible = doc.blocks.filter((block) => !block.hidden)
    expect(visible).toHaveLength(1)
    expect(visible[0].type).toBe('paragraph')
    expect(doc.styles.has('Heading1')).toBe(true)
  })

  it('ships an Excel workbook with one empty worksheet', async () => {
    const zip = await JSZip.loadAsync(template('xlsx'), { checkCRC32: true })
    const workbook = await zip.file('xl/workbook.xml')!.async('string')
    expect(workbook.match(/<sheet\s/g)).toHaveLength(1)
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet).toMatch(/<sheetData\s*\/>|<sheetData>\s*<\/sheetData>/)
    expect(await zip.file('_rels/.rels')!.async('string')).toContain('xl/workbook.xml')
  })

  it('opens the shared PowerPoint template as one empty slide', async () => {
    const opened = await openPptx(template('pptx'))
    expect(opened.deck.slides).toHaveLength(1)
    expect(opened.deck.slides[0].elements).toHaveLength(0)
  })

})
