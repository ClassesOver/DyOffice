import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// react-konva's node entry requires the native 'canvas' package; nothing here draws
vi.mock('react-konva', () => {
  const stub = () => null
  return {
    Stage: stub,
    Layer: stub,
    Rect: stub,
    Group: stub,
    Transformer: stub,
    Line: stub,
    Arrow: stub,
    Text: stub,
    Ellipse: stub,
    Image: stub,
    Path: stub,
    Circle: stub,
    Arc: stub,
  }
})

const captures = vi.hoisted(() => ({ canvas: null as any, overlay: null as any }))
vi.mock('../src/renderer/SlideCanvas', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/renderer/SlideCanvas')>(), selectionChromeColor: () => '#000', SlideCanvas: (props: any) => { captures.canvas = props; return null } }))
vi.mock('../src/renderer/TextEditOverlay', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/renderer/TextEditOverlay')>(), TextEditOverlay: (props: any) => { captures.overlay = props; return createElement('div', { 'data-testid': 'draft-overlay' }) } }))

import { App } from '../src/renderer/App'

/** Recording ResizeObserver: lets the test fire size changes for a target. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  targets = new Set<Element>()
  constructor(private cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element) {
    this.targets.add(el)
    // Real ResizeObserver delivers an initial entry on observe; the stage
    // follow relies on it to baseline the container's border-box size.
    this.cb([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
  static fire(el: Element) {
    for (const inst of FakeResizeObserver.instances) {
      if (inst.targets.has(el)) {
        inst.cb([{ target: el } as ResizeObserverEntry], inst as unknown as ResizeObserver)
      }
    }
  }
}

/** The size fitZoom() sees (content box); fitZoom subtracts 56px (w) / 72px (h) padding. */
let stageSize = { w: 1336, h: 800 } // avail 1280x728 → fit zoom 1 for the blank 1280x720 deck
/** Border box of .stage-wrap: unlike the content box, scrollbars never shrink it. */
let outerSize = { w: 1336, h: 800 }

/** A real window/pane resize: content box and border box change together. */
function resizeStage(w: number, h: number) {
  stageSize = { w, h }
  outerSize = { w, h }
}

const blankSlide = () => ({
  widthPx: 1280,
  heightPx: 720,
  scale: 1,
  nodes: [{ type: 'shape', fill: { kind: 'none' }, id: 'a', sourceId: 'a', box: { x: 0, y: 0, w: 100, h: 100, rotationDeg: 0 }, text: { lines: [] } }],
  background: { kind: 'color', color: '#ffffff' },
})

/** Minimal slidesApi: enough for App to boot into the editor on a blank deck. */
function makeSlidesApi() {
  const explicit: Record<string, unknown> = {
    consumePendingOpen: () => Promise.resolve(null),
    newBlank: () => Promise.resolve({ path: '', slides: [blankSlide()], defaultFont: 'Arial' }),
    isDirty: () => Promise.resolve(false),
    getRecentFiles: () => Promise.resolve([]),
    getAiSettings: () => Promise.resolve(null),
    getSections: () => Promise.resolve([]),
    getComments: () => Promise.resolve([]),
    getNotes: () => Promise.resolve(''),
    getAnimations: () => Promise.resolve([]),
    getTransition: () => Promise.resolve(null),
    listFonts: () => Promise.resolve([]),
  }
  const fallbacks = new Map<string, unknown>()
  return new Proxy(explicit, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (!fallbacks.has(prop)) {
        fallbacks.set(
          prop,
          prop.startsWith('on')
            ? () => () => {} // event subscription → unsubscribe
            : () => Promise.resolve(null),
        )
      }
      return fallbacks.get(prop)
    },
  })
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

function stageZoom(container: HTMLElement): number {
  const el = container.querySelector<HTMLElement>('.stage-scale')
  expect(el, 'stage-scale should be mounted').not.toBeNull()
  const m = /scale\(([\d.]+)\)/.exec(el!.style.transform)
  expect(m, `transform should carry a scale(): ${el!.style.transform}`).not.toBeNull()
  return Number(m![1])
}

let root: Root | null = null
let container: HTMLElement | null = null

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as MediaQueryList
  Element.prototype.scrollTo ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  // fitZoom measures the stage container; jsdom has no layout, so feed it a
  // controllable size (all elements share it — only the stage wrap is measured)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => stageSize.w,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => stageSize.h,
  })
  // Border-box size, mocked only for the stage wrap (other elements keep jsdom's
  // 0 so the zoom-preview transform math stays on its offsetWidth-less path)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('stage-wrap') ? outerSize.w : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('stage-wrap') ? outerSize.h : 0
    },
  })
  ;(window as unknown as { slidesApi: unknown }).slidesApi = makeSlidesApi()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  FakeResizeObserver.instances.length = 0
})

/** Mount the App and boot into a blank deck at fit zoom 1 (1336x800 container). */
async function bootApp(): Promise<HTMLElement> {
  resizeStage(1336, 800)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(App)))
  await settle()
  const wrap = container.querySelector<HTMLElement>('.stage-wrap')
  expect(wrap, 'editor should boot into a blank deck').not.toBeNull()
  expect(stageZoom(container!)).toBeCloseTo(1, 5)
  return wrap!
}


describe('App rejected text commit', () => {
  it('retains the text overlay after null and closes it only after successful retry', async () => {
    await bootApp()
    const editText = vi.fn().mockResolvedValue(null)
    window.slidesApi.editText = editText
    await act(async () => captures.canvas.onEditText('a'))
    expect(container!.querySelector('[data-testid=draft-overlay]')).not.toBeNull()
    const paragraphs = [{ runs: [{ text: 'unsaved draft' }] }]
    await act(async () => captures.overlay.onCommit(paragraphs))
    expect(editText).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'a', paragraphs }))
    expect(container!.querySelector('[data-testid=draft-overlay]')).not.toBeNull()
    editText.mockResolvedValue(blankSlide())
    await act(async () => captures.overlay.onCommit(paragraphs))
    expect(container!.querySelector('[data-testid=draft-overlay]')).toBeNull()
  })
})

describe('App analysis delivery save consent',()=>{
 it('holds blur and timer saves after insertion until an explicit save',async()=>{
  const interval=vi.spyOn(window,'setInterval'),api=makeSlidesApi() as any
  let generation=1,handle:any
  api.consumePendingOpen=async()=>({path:'analysis.pptx',slides:[blankSlide()],defaultFont:'Arial'})
  api.isDirty=vi.fn(async()=>true)
  api.save=vi.fn(async()=>({ok:true,path:'analysis.pptx'}))
  window.slidesApi=api
  localStorage.setItem('ai-slides-auto-save','1')
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
  try{
   await act(async()=>root!.render(createElement(App,{host:{inPlaceSave:true,analysisGeneration:()=>generation,onEditorReady:value=>{handle=value},runAnalysis:async(_ops,check,adopt)=>{if(!check())return false;generation++;adopt([blankSlide()] as any);return true}}})))
   await settle()
   await act(async()=>{expect(await handle.analysis.captureAnalysis().apply({kind:'text',text:'delivery'},()=>true)).toBe(true)})
   const tick=interval.mock.calls.find(call=>call[1]===30_000)?.[0] as ()=>void
   expect(tick).toBeTypeOf('function')
   await act(async()=>{window.dispatchEvent(new Event('blur'));tick();await Promise.resolve()})
   expect(api.save).not.toHaveBeenCalled()
   await act(async()=>{expect(await handle.saveAndWait()).toBe(true)})
   expect(api.save).toHaveBeenCalledTimes(1)
   await act(async()=>{window.dispatchEvent(new Event('blur'));await Promise.resolve()})
   expect(api.save).toHaveBeenCalledTimes(2)
  }finally{localStorage.removeItem('ai-slides-auto-save');interval.mockRestore()}
 })
})
