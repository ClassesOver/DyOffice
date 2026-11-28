/**
 * Measures in-document links (bookmark hyperlinks, TOC entries) on the
 * paginated preview so the PDF export can stamp GoTo annotations: Chromium
 * drops fragment links whose target has no `id` in the print job, and the
 * chunked export never has the target page in the same job anyway.
 *
 * Every body window (`.pv-content[data-pv-body]`: a page's slice or one
 * column of it) is a clone of the document flow pulled up inside a `.pv-clip`
 * box, so an element's flow position is its offset from the clone's top and
 * the window starts where the clip's top edge cuts the clone. Forced breaks
 * take no room in that flow: the window an element belongs to is the last
 * one whose start lies at or before its flow position, not the clone whose
 * box happens to contain it.
 */
import type { Block } from '@genoffice/docx-engine'
import type { PdfInternalLink } from '../shared/ipc'

interface PageBox {
  index: number
  left: number
  top: number
  width: number
  height: number
}

interface FlowWindow {
  el: HTMLElement
  page: PageBox
  start: number
  /** viewport y of flow position 0 */
  top: number
  /** rendered px per flow px (print-markup scale) */
  k: number
}

const norm = (s: string) => s.replace(/\s+/g, '')

function flowWindows(pvPages: HTMLElement[]): FlowWindow[] {
  const out: FlowWindow[] = []
  for (const pageEl of pvPages) {
    const r = pageEl.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const page: PageBox = {
      index: Number(pageEl.dataset.pvPage),
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    }
    for (const el of pageEl.querySelectorAll<HTMLElement>('.pv-content[data-pv-body]')) {
      const clip = el.closest<HTMLElement>('.pv-clip')
      if (!clip) continue
      const cr = el.getBoundingClientRect()
      const k = el.offsetWidth > 0 && cr.width > 0 ? cr.width / el.offsetWidth : 1
      out.push({ el, page, start: (clip.getBoundingClientRect().top - cr.top) / k, top: cr.top, k })
    }
  }
  return out.sort((a, b) => a.start - b.start || a.page.index - b.page.index)
}

/** the last window whose slice starts at or before the flow position */
function windowAt(windows: FlowWindow[], flowY: number): FlowWindow {
  let hit = windows[0]
  for (const w of windows) {
    if (flowY >= w.start - 1) hit = w
    else break
  }
  return hit
}

export function collectPdfInternalLinks(
  pvPages: HTMLElement[],
  blocks: Pick<Block, 'docxIndex' | 'bookmarks' | 'hiddenBookmarks'>[],
): PdfInternalLink[] {
  const windows = flowWindows(pvPages)
  if (windows.length === 0) return []

  const sources: Array<{ el: HTMLElement; win: FlowWindow; anchor: string; title: string }> = []
  for (const win of windows) {
    const els = win.el.querySelectorAll<HTMLElement>('a[href^="#"], .doc-toc-line')
    for (const el of els) {
      const href = el.getAttribute('href')
      const anchor = href ? href.slice(1) : (el.dataset.tocAnchor ?? '')
      const title = href ? '' : norm(el.dataset.tocTitle ?? '')
      if (anchor || title) sources.push({ el, win, anchor, title })
    }
  }
  if (sources.length === 0) return []

  const idxByAnchor = new Map<string, number>()
  for (const b of blocks) {
    if (b.docxIndex == null) continue
    for (const a of [...(b.hiddenBookmarks ?? []), ...(b.bookmarks ?? [])])
      if (!idxByAnchor.has(a)) idxByAnchor.set(a, b.docxIndex)
  }
  const neededIdx = new Set<number>()
  const neededTitles = new Set<string>()
  for (const s of sources) {
    const idx = idxByAnchor.get(s.anchor)
    if (idx !== undefined) neededIdx.add(idx)
    else if (s.title) neededTitles.add(s.title)
  }

  const flowOf = (viewportY: number, win: FlowWindow) => (viewportY - win.top) / win.k
  const destination = (flowY: number) => {
    const win = windowAt(windows, flowY)
    const y = win.top - win.page.top + flowY * win.k
    return { page: win.page.index, yFrac: Math.min(1, Math.max(0, y / win.page.height)) }
  }

  const byIdx = new Map<number, { page: number; yFrac: number }>()
  const byTitle = new Map<string, { page: number; yFrac: number }>()
  for (const win of windows) {
    if (neededIdx.size > byIdx.size) {
      for (const el of win.el.querySelectorAll<HTMLElement>('[data-idx]')) {
        const idx = Number(el.dataset.idx)
        if (!neededIdx.has(idx) || byIdx.has(idx)) continue
        byIdx.set(idx, destination(flowOf(el.getBoundingClientRect().top, win)))
      }
    }
    if (neededTitles.size > byTitle.size) {
      for (const el of win.el.querySelectorAll(':is(h1,h2,h3,h4,h5,h6)')) {
        const title = norm(el.textContent ?? '')
        if (!neededTitles.has(title) || byTitle.has(title)) continue
        byTitle.set(title, destination(flowOf(el.getBoundingClientRect().top, win)))
      }
    }
  }

  const out: PdfInternalLink[] = []
  for (const s of sources) {
    const idx = idxByAnchor.get(s.anchor)
    const target = idx !== undefined ? byIdx.get(idx) : byTitle.get(s.title)
    if (!target) continue
    const { page } = s.win
    for (const r of s.el.getClientRects()) {
      // each line box belongs to exactly one window's clone
      if (windowAt(windows, flowOf((r.top + r.bottom) / 2, s.win)) !== s.win) continue
      const x1 = Math.max(0, r.left - page.left)
      const y1 = Math.max(0, r.top - page.top)
      const x2 = Math.min(page.width, r.right - page.left)
      const y2 = Math.min(page.height, r.bottom - page.top)
      if (x2 - x1 < 1 || y2 - y1 < 1) continue
      out.push({
        page: page.index,
        x: x1 / page.width,
        y: y1 / page.height,
        w: (x2 - x1) / page.width,
        h: (y2 - y1) / page.height,
        toPage: target.page,
        toY: target.yFrac,
      })
    }
  }
  return out
}

/** Chromium can write native PDF destinations for unique IDs in the printed range. */
export function addBrowserPrintLinks(
  pages: HTMLElement[],
  printedPages: HTMLElement[],
  blocks: Parameters<typeof collectPdfInternalLinks>[1],
): () => void {
  const pageByIndex = new Map(printedPages.map((page) => [Number(page.dataset.pvPage), page]))
  const layers = new Map<HTMLElement, HTMLDivElement>()
  const destinations = new Map<string, string>()
  const layerFor = (page: HTMLElement) => {
    let layer = layers.get(page)
    if (!layer) {
      layer = page.ownerDocument.createElement('div')
      layer.className = 'pv-print-links'
      layer.setAttribute('aria-hidden', 'true')
      page.appendChild(layer)
      layers.set(page, layer)
    }
    return layer
  }
  for (const link of collectPdfInternalLinks(pages, blocks)) {
    const source = pageByIndex.get(link.page)
    const target = pageByIndex.get(link.toPage)
    if (!source || !target) continue
    const key = `${link.toPage}:${link.toY}`
    let id = destinations.get(key)
    if (!id) {
      id = `word-print-destination-${destinations.size}`
      destinations.set(key, id)
      const marker = target.ownerDocument.createElement('span')
      marker.id = id
      marker.style.top = `${link.toY * 100}%`
      layerFor(target).appendChild(marker)
    }
    const anchor = source.ownerDocument.createElement('a')
    anchor.href = `#${id}`
    anchor.tabIndex = -1
    anchor.style.left = `${link.x * 100}%`
    anchor.style.top = `${link.y * 100}%`
    anchor.style.width = `${link.w * 100}%`
    anchor.style.height = `${link.h * 100}%`
    layerFor(source).appendChild(anchor)
  }
  return () => layers.forEach((layer) => layer.remove())
}

/** the edit canvas holds links the direct (preview-less) print would export dead */
export function hasInternalLinks(): boolean {
  return document.querySelector('.ProseMirror a[href^="#"], .ProseMirror .doc-toc-line') !== null
}
