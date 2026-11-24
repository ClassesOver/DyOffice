import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openPptx, savePptx, duplicateSlide, insertBlankSlide, getSlideNotes, setSlideNotes } from '../src/index'
import { notesPathForSlide } from '../src/notes'
import { resolveTarget } from '../src/zip'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(join(here, 'fixtures', name))

const slideText = (slide: any): string =>
  slide.elements
    .filter((e: any) => e.type === 'text' || e.type === 'shape')
    .flatMap((e: any) => e.text?.paragraphs ?? [])
    .flatMap((p: any) => p.runs)
    .map((r: any) => r.text)
    .join('')

describe('duplicateSlide', () => {
  it('inserts a copy right after the source and survives save → reopen', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const before = opened.deck.slides.length
    const srcText = slideText(opened.deck.slides[0])
    const dup = duplicateSlide(opened, 0)
    expect(dup).not.toBeNull()
    expect(opened.deck.slides.length).toBe(before + 1)
    expect(opened.deck.slides[1]).toBe(dup)

    const reopened = await openPptx(await savePptx(opened))
    expect(reopened.deck.slides.length).toBe(before + 1)
    // sldIdLst order: the copy comes right after the source slide
    expect(slideText(reopened.deck.slides[1])).toBe(srcText)
  })

  it('carries the source page pending edits into the copy', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const src = opened.deck.slides[0]!
    const el: any = src.elements.find((e: any) => (e.type === 'text' || e.type === 'shape') && e.text)
    el.text.paragraphs = [{ runs: [{ text: 'edited before copying' }] }]
    el.dirty = true

    duplicateSlide(opened, 0)
    const reopened = await openPptx(await savePptx(opened))
    expect(slideText(reopened.deck.slides[1])).toContain('edited before copying')
  })

  it('duplicates the notes part with its own slide relationship and editable contents', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const sourcePath = opened.deck.slides[0]!.path
    setSlideNotes(opened, 0, 'Original speaker note')
    const sourceNotes = notesPathForSlide(opened.archive, sourcePath)!
    const { path: copyPath } = duplicateSlide(opened, 0)!
    const reopened = await openPptx(await savePptx(opened))
    const copyNotes = notesPathForSlide(reopened.archive, copyPath)
    expect(getSlideNotes(reopened.archive, copyPath)).toBe('Original speaker note')
    expect(copyNotes).not.toBe(sourceNotes)
    expect(reopened.archive.readText(copyNotes!)).toBe(reopened.archive.readText(sourceNotes))
    const owner = [...reopened.archive.readRels(copyNotes!).values()].find(rel => rel.type.endsWith('/slide'))
    expect(resolveTarget(copyNotes!, owner!.target)).toBe(copyPath)
    setSlideNotes(reopened, 1, 'Updated copy')
    expect(getSlideNotes(reopened.archive, sourcePath)).toBe('Original speaker note')
    expect(getSlideNotes(reopened.archive, copyPath)).toBe('Updated copy')
  })

  it('clearText makes a layout-preserving blank page', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const srcCount = opened.deck.slides[0]!.elements.length
    setSlideNotes(opened, 0, 'Only on the original')
    duplicateSlide(opened, 0, { clearText: true })

    const reopened = await openPptx(await savePptx(opened))
    const copy = reopened.deck.slides[1]!
    expect(copy.elements.length).toBe(srcCount)
    expect(slideText(copy)).toBe('')
    expect(getSlideNotes(reopened.archive, copy.path)).toBe('')
  })

  it('two duplicates get distinct part paths and sldIds', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const a = duplicateSlide(opened, 0)!
    const b = duplicateSlide(opened, 0)!
    expect(a.path).not.toBe(b.path)

    const reopened = await openPptx(await savePptx(opened))
    expect(reopened.deck.slides.length).toBe(7)
  })
})

describe('insertBlankSlide', () => {
  it('inserts an element-free slide after the source and survives save → reopen', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const before = opened.deck.slides.length
    const blank = insertBlankSlide(opened, 0)
    expect(blank).not.toBeNull()
    expect(opened.deck.slides.length).toBe(before + 1)
    expect(opened.deck.slides[1]).toBe(blank)
    expect(blank!.elements.length).toBe(0)

    const reopened = await openPptx(await savePptx(opened))
    expect(reopened.deck.slides.length).toBe(before + 1)
    expect(reopened.deck.slides[1]!.elements.length).toBe(0)
  })

  it('reuses the source slide layout relationship', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const src = opened.deck.slides[0]!
    const blank = insertBlankSlide(opened, 0)!
    const layoutOf = (p: string) =>
      [...opened.archive.readRels(p).values()].find((r) => r.type.endsWith('/slideLayout'))
        ?.target
    expect(layoutOf(blank.path)).toBeTruthy()
    expect(layoutOf(blank.path)).toBe(layoutOf(src.path))
  })
})
