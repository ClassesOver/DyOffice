import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { XMLValidator } from 'fast-xml-parser'
import {
  openPptx,
  savePptx,
  copySlide,
  pasteSlide,
  planSlidePastes,
  listLayouts,
  chooseLayout,
  materializeSlideBundle,
  getSlideNotes,
  getSlideLinks,
  setSlideNotes,
  setElementLink,
  notesPathForSlide,
  getSections,
  setSections,
  deleteSlide,
  insertBlankSlide,
} from '../src/index'
import type { SlideBundle } from '../src/index'
import { relsPathFor, resolveTarget } from '../src/zip'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(join(here, 'fixtures', name))

const slideText = (slide: any): string =>
  slide.elements
    .filter((e: any) => e.type === 'text' || e.type === 'shape')
    .flatMap((e: any) => e.text?.paragraphs ?? [])
    .flatMap((p: any) => p.runs)
    .map((r: any) => r.text)
    .join('')

describe('copySlide / pasteSlide across decks', () => {
  it.each([0, 1])('keeps the section of a cut slide pasted back at index %i after reopening', async (index) => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const sections = [
      { id: '{00000000-0000-4000-8000-000000000001}', name: 'First', slideIndices: [0] },
      { id: '{00000000-0000-4000-8000-000000000002}', name: 'Second', slideIndices: [1] },
      { id: '{00000000-0000-4000-8000-000000000003}', name: 'Rest', slideIndices: [2, 3, 4] },
    ]
    setSections(opened, sections)
    const bundle = copySlide(opened, index)!
    expect(deleteSlide(opened, index)).toBe(true)
    const plan = planSlidePastes(opened, [bundle], true, true)[0]!
    expect(pasteSlide(opened, index - 1, bundle, { plan })?.path).toBe(bundle.sourcePath)
    const reopened = await openPptx(await savePptx(opened))
    expect(getSections(reopened)).toEqual(sections)
  })

  it('reserves the numeric ID of a cut last slide while a new slide is inserted', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const section = { id: '{00000000-0000-4000-8000-000000000004}', name: 'Cut target', slideIndices: [4] }
    setSections(opened, [section])
    const bundle = copySlide(opened, 4)!
    expect(deleteSlide(opened, 4)).toBe(true)
    expect(insertBlankSlide(opened, 3)).not.toBeNull()
    expect(getSections(opened)[0]?.slideIndices).toEqual([])
    const plan = planSlidePastes(opened, [bundle], true, true)[0]!
    expect(pasteSlide(opened, 3, bundle, { plan })?.path).toBe(bundle.sourcePath)
    expect(getSections(opened)[0]?.slideIndices).toEqual([4])
  })

  it('assigns a cut slide moved to another section as a thumbnail move would', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    setSections(opened, [
      { id: '{00000000-0000-4000-8000-000000000001}', name: 'First', slideIndices: [0, 1] },
      { id: '{00000000-0000-4000-8000-000000000002}', name: 'Last', slideIndices: [2, 3, 4] },
    ])
    const bundle = copySlide(opened, 1)!
    expect(deleteSlide(opened, 1)).toBe(true)
    const plan = planSlidePastes(opened, [bundle], true, true)[0]!
    expect(pasteSlide(opened, 3, bundle, { plan })?.path).toBe(bundle.sourcePath)
    expect(opened.deck.slides[4]?.path).toBe(bundle.sourcePath)
    expect(getSections(opened).map(section => section.slideIndices)).toEqual([[0], [1, 2, 3, 4]])
  })

  it('carries a slide into another deck and survives save → reopen', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const sourceText = slideText(source.deck.slides[0])
    const targetCount = target.deck.slides.length

    const bundle = copySlide(source, 0)
    expect(bundle).not.toBeNull()
    const pasted = pasteSlide(target, 0, bundle!)
    expect(pasted).not.toBeNull()
    expect(target.deck.slides.length).toBe(targetCount + 1)
    expect(target.deck.slides[1]).toBe(pasted)

    const reopened = await openPptx(await savePptx(target))
    expect(reopened.deck.slides.length).toBe(targetCount + 1)
    expect(slideText(reopened.deck.slides[1])).toBe(sourceText)
  })

  it('points the pasted slide at a layout that exists in the destination', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const bundle = copySlide(source, 0)!
    const pasted = pasteSlide(target, 0, bundle)!

    const layoutRel = [...target.archive.readRels(pasted.path).values()].find((rel) =>
      rel.type.endsWith('/slideLayout'),
    )
    expect(layoutRel).toBeDefined()
    const layoutPath = `ppt/${layoutRel!.target.replace('../', '')}`
    expect(listLayouts(target.archive).map((l) => l.path)).toContain(layoutPath)
    // the source's own layout part must not have been dragged along
    expect(target.archive.has('ppt/slideLayouts/slideLayout99.xml')).toBe(false)
  })

  it('copies referenced media under a fresh name without clobbering the target', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const mediaBefore = [...target.archive.entries.keys()].filter((p) => p.startsWith('ppt/media/'))
    const sourceMedia = [...source.archive.entries.keys()].filter((p) => p.startsWith('ppt/media/'))

    const bundle = copySlide(source, 0)!
    const pasted = pasteSlide(target, 0, bundle)!
    const rels = [...target.archive.readRels(pasted.path).values()]
    const imageRels = rels.filter((rel) => rel.type.endsWith('/image'))

    for (const rel of imageRels) {
      const path = `ppt/${rel.target.replace('../', '')}`
      expect(target.archive.has(path)).toBe(true)
    }
    // nothing that already existed in the target was overwritten
    for (const path of mediaBefore) expect(target.archive.has(path)).toBe(true)
    if (sourceMedia.length > 0 && imageRels.length > 0) {
      const after = [...target.archive.entries.keys()].filter((p) => p.startsWith('ppt/media/'))
      expect(after.length).toBeGreaterThan(mediaBefore.length)
    }

    // every content type the new parts need is declared
    const ct = target.archive.readText('[Content_Types].xml')!
    for (const rel of imageRels) {
      const ext = rel.target.slice(rel.target.lastIndexOf('.') + 1).toLowerCase()
      expect(ct.toLowerCase()).toContain(`extension="${ext}"`)
    }
  })

  it('keeps rIds stable so the pasted slide XML needs no rewriting', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const sourceRelIds = [...source.archive.readRels(source.deck.slides[0]!.path).values()]
      .filter((rel) => !rel.type.endsWith('/notesSlide'))
      .map((rel) => rel.id)
      .sort()

    const pasted = pasteSlide(target, 0, copySlide(source, 0)!)!
    const pastedRelIds = [...target.archive.readRels(pasted.path).values()]
      .map((rel) => rel.id)
      .sort()
    expect(pastedRelIds).toEqual(sourceRelIds)
  })

  it('gives each bundled media part its own destination when names collide with the target', async () => {
    const target = await openPptx(fx('01_standard_business.pptx'))
    // the target now occupies both names the bundle wants
    target.archive.entries.set('ppt/media/image2.png', new Uint8Array([9, 9, 9]))

    const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
    const LAYOUT_REL =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'
    const bundle: SlideBundle = {
      slideXml: '<p:sld/>',
      rels: [
        { id: 'rId1', type: LAYOUT_REL, target: 'ppt/slideLayouts/slideLayout1.xml', layout: true },
        { id: 'rId2', type: IMAGE_REL, target: 'ppt/media/image1.png' },
        { id: 'rId3', type: IMAGE_REL, target: 'ppt/media/image2.png' },
      ],
      parts: {
        'ppt/media/image1.png': Buffer.from('AAAA-image-A').toString('base64'),
        'ppt/media/image2.png': Buffer.from('BBBB-image-B').toString('base64'),
      },
      contentTypes: { png: 'image/png' },
    }

    const layoutPath = chooseLayout(target.archive, bundle)!
    const relsXml = materializeSlideBundle(
      target.archive,
      bundle,
      'ppt/slides/slide99.xml',
      layoutPath,
    )

    const targets = [...relsXml.matchAll(/Target="(\.\.\/media\/[^"]+)"/g)].map((m) => m[1]!)
    expect(new Set(targets).size).toBe(2)
    const bytesAt = (t: string) =>
      Buffer.from(target.archive.readBytes('ppt/' + t.replace('../', ''))!).toString()
    expect(bytesAt(targets[0]!)).toBe('AAAA-image-A')
    expect(bytesAt(targets[1]!)).toBe('BBBB-image-B')
  })

  it('pastes at the front when afterIndex is -1', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const sourceText = slideText(source.deck.slides[0])

    const pasted = pasteSlide(target, -1, copySlide(source, 0)!)
    expect(target.deck.slides[0]).toBe(pasted)
    const reopened = await openPptx(await savePptx(target))
    expect(slideText(reopened.deck.slides[0])).toBe(sourceText)
  })

  it('keep-source-formatting imports the source layout chain and registers its master', async () => {
    // forge a source deck whose theme differs from the target's
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const themeXml = source.archive.readText('ppt/theme/theme1.xml')!
    source.archive.entries.set(
      'ppt/theme/theme1.xml',
      Buffer.from(themeXml.replace('4F81BD', '123456'), 'utf8'),
    )
    const target = await openPptx(fx('01_standard_business.pptx'))
    const masters = () =>
      [...target.archive.entries.keys()].filter((p) =>
        /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p),
      ).length
    const mastersBefore = masters()

    const bundle = copySlide(source, 0)!
    expect(bundle.chain).toBeDefined()
    const pasted = pasteSlide(target, 0, bundle, { keepSourceFormatting: true })
    expect(pasted).not.toBeNull()

    // a new master arrived and is registered in presentation.xml(.rels)
    expect(masters()).toBe(mastersBefore + 1)
    const pres = target.archive.readText('ppt/presentation.xml')!
    expect([...pres.matchAll(/<p:sldMasterId\s/g)].length).toBe(mastersBefore + 1)

    // the pasted slide points at the imported layout (byte-identical to the source's)
    const layoutRel = [...target.archive.readRels(pasted!.path).values()].find((rel) =>
      rel.type.endsWith('/slideLayout'),
    )!
    const layoutPath = `ppt/${layoutRel.target.replace('../', '')}`
    expect(target.archive.readText(layoutPath)).toBe(
      source.archive.readText(bundle.chain!.layoutPath),
    )

    // survives save → reopen
    const reopened = await openPptx(await savePptx(target))
    expect(reopened.deck.slides.length).toBe(target.deck.slides.length)
  })

  it('keep-source-formatting reuses an identical existing master instead of importing', async () => {
    // the two fixtures share one template: the chain must be reused, not duplicated
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const masterParts = () =>
      [...target.archive.entries.keys()].filter((p) => p.startsWith('ppt/slideMasters/')).length
    const mastersBefore = masterParts()

    const bundle = copySlide(source, 0)!
    expect(pasteSlide(target, 0, bundle, { keepSourceFormatting: true })).not.toBeNull()
    expect(masterParts()).toBe(mastersBefore)
  })

  it('pasting the same foreign chain twice imports its master only once', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const themeXml = source.archive.readText('ppt/theme/theme1.xml')!
    source.archive.entries.set(
      'ppt/theme/theme1.xml',
      Buffer.from(themeXml.replace('4F81BD', '123456'), 'utf8'),
    )
    const target = await openPptx(fx('01_standard_business.pptx'))
    const masters = () =>
      [...target.archive.entries.keys()].filter((p) =>
        /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p),
      ).length
    const mastersBefore = masters()

    const bundle = copySlide(source, 0)!
    pasteSlide(target, 0, bundle, { keepSourceFormatting: true })
    pasteSlide(target, 1, bundle, { keepSourceFormatting: true })
    expect(masters()).toBe(mastersBefore + 1)
  })

  it('keep-source-formatting falls back to the destination theme without a chain', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const { chain: _chain, ...rest } = copySlide(source, 0)!
    const pasted = pasteSlide(target, 0, rest as SlideBundle, { keepSourceFormatting: true })
    expect(pasted).not.toBeNull()
    const layoutRel = [...target.archive.readRels(pasted!.path).values()].find((rel) =>
      rel.type.endsWith('/slideLayout'),
    )!
    const layoutPath = `ppt/${layoutRel.target.replace('../', '')}`
    expect(listLayouts(target.archive).map((l) => l.path)).toContain(layoutPath)
  })

  it('pasting twice produces two independent slides', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const bundle = copySlide(source, 0)!
    const first = pasteSlide(target, 0, bundle)!
    const second = pasteSlide(target, 1, bundle)!
    expect(first.path).not.toBe(second.path)

    const reopened = await openPptx(await savePptx(target))
    expect(reopened.deck.slides.length).toBe(target.deck.slides.length)
    expect(slideText(reopened.deck.slides[1])).toBe(slideText(reopened.deck.slides[2]))
  })
})


describe('notes and slide jumps in editable slide pastes', () => {
  it('copies a standalone notes part, preserves its rich text, and sets its backlink to the pasted slide', async () => {
    const source = await openPptx(fx('05_unicode_cjk_emoji.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    const original = source.deck.slides[0]!
    expect(setSlideNotes(source, 0, 'First line\nSecond & third')).toBe(true)
    const sourceNotes = notesPathForSlide(source.archive, original.path)!
    const richNotes = source.archive.readText(sourceNotes)!.replace('dirty="0"', 'dirty="0" b="1"')
    source.archive.entries.set(sourceNotes, Buffer.from(richNotes))
    expect(setSlideNotes(target, 0, 'Keep the target’s own notes')).toBe(true)
    const targetNotes = notesPathForSlide(target.archive, target.deck.slides[0]!.path)!

    const paste = pasteSlide(target, 0, copySlide(source, 0)!)!
    const reopened = await openPptx(await savePptx(target))
    expect(getSlideNotes(reopened.archive, paste.path)).toBe('First line\nSecond & third')
    const pastedNotes = notesPathForSlide(reopened.archive, paste.path)!
    expect(pastedNotes).not.toBe(targetNotes)
    expect(reopened.archive.readText(pastedNotes)).toBe(richNotes)
    expect(getSlideNotes(reopened.archive, reopened.deck.slides[0]!.path)).toBe('Keep the target’s own notes')
    const rels = [...reopened.archive.readRels(pastedNotes).values()]
    const back = rels.find(rel => rel.type.endsWith('/slide'))!
    const master = rels.find(rel => rel.type.endsWith('/notesMaster'))!
    expect(resolveTarget(pastedNotes, back.target)).toBe(paste.path)
    expect(reopened.archive.has(resolveTarget(pastedNotes, master.target))).toBe(true)
  })

  it('keeps a jump to the same deck’s original destination without creating any unlisted slide parts', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const first = opened.deck.slides[0]!
    const target = opened.deck.slides[1]!
    expect(setElementLink(opened, 0, first.elements[0]!.id, { kind: 'slide', slideIndex: 1 })).not.toBeNull()
    const paste = pasteSlide(opened, 0, copySlide(opened, 0)!)!
    const reopened = await openPptx(await savePptx(opened))
    expect(getSlideLinks(reopened, 1).map(link => link.target)).toEqual([{ kind: 'slide', slideIndex: 2 }])
    expect(reopened.deck.slides[2]!.path).toBe(target.path)
    const parts = [...reopened.archive.entries.keys()].filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    expect(parts.sort()).toEqual(reopened.deck.slides.map(slide => slide.path).sort())
    expect(reopened.deck.slides[1]!.path).toBe(paste.path)
  })

  it('retains the notes slide content type when the source override uses a different attribute order', async () => {
    const source = await openPptx(fx('01_standard_business.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    setSlideNotes(source, 0, 'Notes with a reordered override')
    const sourceNotes = notesPathForSlide(source.archive, source.deck.slides[0]!.path)!
    const type = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'
    const typesPath = '[Content_Types].xml'
    const types = source.archive.readText(typesPath)!
      .replace(`<Override PartName="/${sourceNotes}" ContentType="${type}"/>`, `<Override ContentType='${type}' PartName='/${sourceNotes}' />`)
    expect(types).toContain(`<Override ContentType='${type}' PartName='/${sourceNotes}' />`)
    source.archive.entries.set(typesPath, Buffer.from(types))
    const pasted = pasteSlide(target, 0, copySlide(source, 0)!)!
    const pastedNotes = notesPathForSlide(target.archive, pasted.path)!
    expect(target.archive.readText(typesPath)).toContain(`<Override PartName="/${pastedNotes}" ContentType="${type}"/>`)
  })

  it('removes a paired unresolved relationship tag from a pasted notes part', async () => {
    const source = await openPptx(fx('01_standard_business.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    setSlideNotes(source, 0, 'Notes with a jump')
    const sourceNotes = notesPathForSlide(source.archive, source.deck.slides[0]!.path)!
    const sourceNotesRels = relsPathFor(sourceNotes)
    const jump = '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide2.xml">\n</Relationship>'
    source.archive.entries.set(sourceNotesRels, Buffer.from(source.archive.readText(sourceNotesRels)!
      .replace('</Relationships>', () => `${jump}</Relationships>`)))
    const pasted = pasteSlide(target, 0, copySlide(source, 0)!)!
    const pastedNotes = notesPathForSlide(target.archive, pasted.path)!
    const relsXml = target.archive.readText(relsPathFor(pastedNotes))!
    expect(relsXml).not.toContain('rId99')
    expect(XMLValidator.validate(relsXml)).toBe(true)
  })

  it('retargets both directions of a jump within a pasted cross-deck selection', async () => {
    const source = await openPptx(fx('01_standard_business.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    for (const index of [0, 1]) {
      const element = source.deck.slides[index]!.elements[0]!
      expect(setElementLink(source, index, element.id, { kind: 'slide', slideIndex: 1 - index })).not.toBeNull()
    }
    // Match the Web worker's serialized clipboard, which carries no object identity.
    const bundles = JSON.parse(JSON.stringify([copySlide(source, 0), copySlide(source, 1)])) as SlideBundle[]
    const plans = planSlidePastes(target, bundles, false)
    for (const [index, bundle] of bundles.entries()) {
      expect(pasteSlide(target, index, bundle, {plan: plans[index]!})).not.toBeNull()
    }
    const reopened = await openPptx(await savePptx(target))
    expect(getSlideLinks(reopened, 1).map(link => link.target)).toEqual([{ kind: 'slide', slideIndex: 2 }])
    expect(getSlideLinks(reopened, 2).map(link => link.target)).toEqual([{ kind: 'slide', slideIndex: 1 }])
    const parts = [...reopened.archive.entries.keys()].filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    expect(parts.sort()).toEqual(reopened.deck.slides.map(slide => slide.path).sort())
  })

  it('removes an unresolved cross-deck jump instead of binding it to a coincidental part path', async () => {
    const source = await openPptx(fx('01_standard_business.pptx'))
    const target = await openPptx(fx('01_standard_business.pptx'))
    expect(setElementLink(source, 0, source.deck.slides[0]!.elements[0]!.id, { kind: 'slide', slideIndex: 1 })).not.toBeNull()
    expect(setSlideNotes(source, 0, 'Notes without an existing master in the destination')).toBe(true)
    const bundle = copySlide(source, 0)!
    const pasted = pasteSlide(target, 0, bundle)!
    expect(getSlideLinks(target, 1)).toEqual([])
    expect(target.archive.readText(pasted.path)).not.toContain('hlinksldjump')
    expect([...target.archive.readRels(pasted.path).values()].some(rel => rel.type.endsWith('/slide'))).toBe(false)
    expect(getSlideNotes(target.archive, pasted.path)).toBe('Notes without an existing master in the destination')
    expect([...target.archive.readRels('ppt/presentation.xml').values()].some(rel => rel.type.endsWith('/notesMaster'))).toBe(true)
  })
})
