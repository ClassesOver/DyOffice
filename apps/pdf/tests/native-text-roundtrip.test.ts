// @vitest-environment node
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { savePdfToPath } from '../src/main/save-pdf'

// Complements the in-memory text-edit tests and annotation-only atomic save tests.
// This is headless native-file roundtrip coverage, not browser UI/HTTP save coverage.
test('text replacement survives save-to-path and independent PDF.js reopen', async () => {
  // Standard Helvetica and same-repertoire ASCII edits need no platform font.
  // No conditional early return: missing PDFium/assets must fail this test.
  const directory = await mkdtemp(join(tmpdir(), 'pdf-native-roundtrip-'))
  try {
    const original = 'Total revenue was 1500 dollars'
    const replacement = 'Total revenue was 5100 dollars'
    const doc = await PDFDocument.create()
    const page = doc.addPage([595, 842])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText(original, { x: 50, y: 700, size: 14, font })
    const bytes = await doc.save({ useObjectStreams: false })
    const source = join(directory, 'original.pdf')
    const target = join(directory, 'edited.pdf')
    await writeFile(source, bytes)

    const result = await savePdfToPath(source, target, {
      path: source,
      targetPath: target,
      markups: [], drawings: [], formValues: [], stamps: [],
      textEdits: [{
        pageIndex: 0,
        rect: [45, 694, 50 + font.widthOfTextAtSize(original, 14) + 5, 718],
        oldText: original, newText: replacement, fontSize: 14,
      }],
    })
    expect(result.skippedTextEdits).toEqual([])
    expect(result.skippedTextInserts).toEqual([])
    expect(result.skippedImageEdits).toEqual([])
    const output = new Uint8Array(await readFile(target))
    expect(await readFile(source)).toEqual(Buffer.from(bytes))
    expect(Buffer.from(output)).not.toEqual(Buffer.from(bytes))

    const loadingTask = getDocument({ data: output.slice(), useSystemFonts: true })
    try {
      const opened = await loadingTask.promise
      const content = await (await opened.getPage(1)).getTextContent()
      const text = content.items.map(item => 'str' in item ? item.str : '').join('')
      expect(text).toBe(replacement)
      expect(text).not.toContain('1500')
      expect(opened.numPages).toBe(1)
    } finally {
      await loadingTask.destroy()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
