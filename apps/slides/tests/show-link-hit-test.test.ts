import type { RenderNode } from '@genoffice/pptx-render'
import { expect, it } from 'vitest'
import type { LinkTargetOp } from '../src/shared/ipc'
import { buildSteps, computeNodeStates } from '../src/renderer/animation-play'
import { hitShowLink } from '../src/renderer/show-link-hit-test'

const shapeLink = { kind: 'slide', slideIndex: 1 } satisfies LinkTargetOp
const runLink = { kind: 'slide', slideIndex: 2 } satisfies LinkTargetOp

it('prefers a run link in readable text inside a rotated and mirrored group', () => {
  const text = {
    type: 'text',
    sourceId: 'text',
    box: { x: 10, y: 20, w: 60, h: 20, rotationDeg: 0, flipH: false, flipV: false },
    text: {
      insets: { l: 2, t: 2, r: 2, b: 2 },
      lines: [{ top: 0, height: 12, runs: [{ x: 0, widthPx: 20, srcRunIdx: 0 }] }],
    },
  }
  const group = {
    type: 'group',
    sourceId: 'group',
    box: { x: 100, y: 200, w: 100, h: 80, rotationDeg: 90, flipH: true, flipV: false },
    children: [text],
  } as unknown as RenderNode
  const links = new Map([['text', shapeLink]])
  const runs = new Map([['text:0:0', runLink]])
  expect(hitShowLink([group], { x: 162, y: 232 }, links, runs, new Map())).toEqual(runLink)
  expect(hitShowLink([group], { x: 162, y: 265 }, links, runs, new Map())).toEqual(shapeLink)
})

it('matches the visible portion of a linked paragraph during a wipe', () => {
  const text = {
    type: 'text',
    sourceId: 'text',
    box: { x: 100, y: 100, w: 60, h: 80, rotationDeg: 0, flipH: false, flipV: false },
    text: {
      insets: { l: 2, t: 5, r: 2, b: 2 },
      lines: [{ top: 0, height: 40, runs: [{ x: 0, widthPx: 20, srcRunIdx: 0 }] }],
    },
  } as unknown as RenderNode
  const steps = buildSteps([{
    sourceId: 'text', paragraph: 0, effect: 'wipe', direction: 'top', trigger: 'onClick',
    durationMs: 100, delayMs: 0,
  }])
  const states = computeNodeStates(steps, 0, 50, 540, 960)
  const links = new Map<string, LinkTargetOp>()
  const runs = new Map([['text:0:0', runLink]])
  expect(hitShowLink([text], { x: 110, y: 110 }, links, runs, states)).toEqual(runLink)
  expect(hitShowLink([text], { x: 110, y: 140 }, links, runs, states)).toBeNull()
})
