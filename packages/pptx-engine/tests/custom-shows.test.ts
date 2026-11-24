import { describe, expect, it } from 'vitest'
import {
  copySlide,
  createBlankPptx,
  deleteSlide,
  getCustomShows,
  insertBlankSlide,
  moveSlide,
  openPptx,
  pasteSlide,
  planSlidePastes,
  savePptx,
  setCustomShows,
} from '../src/index'

const PRESENTATION = 'ppt/presentation.xml'

describe('native custom shows', () => {
  it('persists custom slide order, repeated slides, names, and distinct numeric IDs', async () => {
    const opened = await openPptx(await createBlankPptx())
    const first = opened.deck.slides[0]!.path
    const second = insertBlankSlide(opened, 0)!.path
    const name = 'R&D <北京> "demo"'

    expect(setCustomShows(opened, [
      { id: 'draft-one', name, slidePaths: [second, first, second] },
      { id: '4294967295', name: 'Overflow boundary', slidePaths: [first] },
    ])).toBe(true)
    expect(moveSlide(opened, 0, 1)).toBe(true)
    const reopened = await openPptx(await savePptx(opened))
    const shows = getCustomShows(reopened)
    expect(shows).toEqual([
      { id: expect.stringMatching(/^\d+$/), name, slidePaths: [second, first, second] },
      { id: '4294967295', name: 'Overflow boundary', slidePaths: [first] },
    ])
    expect(shows[0]!.id).not.toBe(shows[1]!.id)
    const xml = reopened.archive.readText(PRESENTATION)!
    expect(xml).toMatch(/<p:notesSz[^>]*\/>\s*<p:custShowLst>/)
  })

  it('preserves imported custom show extension bytes when editing the existing show', async () => {
    const opened = await openPptx(await createBlankPptx())
    const first = opened.deck.slides[0]!.path
    const slideRid = [...opened.archive.readRels(PRESENTATION).values()].find(rel => rel.type.endsWith('/slide'))!.id
    const xml = opened.archive.readText(PRESENTATION)!
    const extension = '<p:extLst><p:ext uri="urn:example"><x:data xmlns:x="urn:example"/></p:ext></p:extLst>'
    const customShows = `<p:custShowLst><p:custShow id='17' name='Old &amp; Name'><p:sldLst><p:sld r:id='${slideRid}'/></p:sldLst>${extension}</p:custShow></p:custShowLst>`
    opened.archive.entries.set(PRESENTATION, Buffer.from(xml.replace('</p:presentation>', () => customShows + '</p:presentation>')))
    expect(getCustomShows(opened)).toEqual([{ id: '17', name: 'Old & Name', slidePaths: [first] }])
    expect(setCustomShows(opened, [{ id: '17', name: 'Renamed', slidePaths: [first] }])).toBe(true)
    expect(opened.archive.readText(PRESENTATION)).toContain(extension)
    expect(getCustomShows(opened)).toEqual([{ id: '17', name: 'Renamed', slidePaths: [first] }])
  })

  it('removes deleted slide references before inserting a different slide', async () => {
    const opened = await openPptx(await createBlankPptx())
    const first = opened.deck.slides[0]!.path
    const second = insertBlankSlide(opened, 0)!.path
    expect(setCustomShows(opened, [{ id: '1', name: 'Original show', slidePaths: [second, first, second] }])).toBe(true)
    expect(deleteSlide(opened, 1)).toBe(true)
    expect(insertBlankSlide(opened, 0)!.path).not.toBe(second)
    const reopened = await openPptx(await savePptx(opened))
    expect(getCustomShows(reopened)).toEqual([{ id: '1', name: 'Original show', slidePaths: [first] }])
  })

  it('rejects missing slide paths before writing any custom-show changes', async () => {
    const opened = await openPptx(await createBlankPptx())
    const before = opened.archive.readText(PRESENTATION)
    expect(setCustomShows(opened, [{ id: 'draft', name: 'Test', slidePaths: ['ppt/slides/missing.xml'] }])).toBe(false)
    expect(opened.archive.readText(PRESENTATION)).toBe(before)
  })

  it('restores the custom-show order when cut slides are moved within the same deck', async () => {
    const opened = await openPptx(await createBlankPptx())
    const first = opened.deck.slides[0]!.path
    const second = insertBlankSlide(opened, 0)!.path
    const third = insertBlankSlide(opened, 1)!.path
    const shows = [{ id: '8', name: 'Demo', slidePaths: [third, second, first, third] }]
    expect(setCustomShows(opened, shows)).toBe(true)
    const bundles = [copySlide(opened, 1)!, copySlide(opened, 2)!]
    expect(deleteSlide(opened, 2)).toBe(true)
    expect(deleteSlide(opened, 1)).toBe(true)
    expect(getCustomShows(opened)).toEqual([{ id: '8', name: 'Demo', slidePaths: [first] }])

    const plans = planSlidePastes(opened, bundles, true, true)
    for (const [i, bundle] of bundles.entries()) {
      expect(pasteSlide(opened, i, bundle, { plan: plans[i] })).not.toBeNull()
    }
    expect(getCustomShows(await openPptx(await savePptx(opened)))).toEqual(shows)
  })
})
