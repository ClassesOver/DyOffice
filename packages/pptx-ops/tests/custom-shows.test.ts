import { createBlankPptx, getCustomShows, openPptx } from '@genoffice/pptx-engine'
import { expect, it } from 'vitest'
import { runTxn } from '../src/index'

it('applies the registered custom-show operation and reports native show IDs', async () => {
  const deck = await openPptx(await createBlankPptx())
  const slidePaths = [deck.deck.slides[0]!.path]
  const edited = runTxn(deck, { ops: [{ op: 'setCustomShows', shows: [{ id: 'draft', name: 'Test', slidePaths }] }] })
  expect(edited.applied).toBe(true)
  const shows = getCustomShows(deck)
  expect(shows).toEqual([{ id: expect.stringMatching(/^\d+$/), name: 'Test', slidePaths }])
  expect(edited.records?.[0]?.after).toEqual(shows)
  expect(runTxn(deck, { ops: [{ op: 'setCustomShows', shows: [{ id: 'draft', name: 'Invalid', slidePaths: [0] }] }] }).applied).toBe(false)
  expect(getCustomShows(deck)).toEqual(shows)
})
