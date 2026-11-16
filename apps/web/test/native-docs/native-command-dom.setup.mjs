import { JSDOM } from 'jsdom'
const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true })
// Keep Node URL/fetch/crypto and import.meta file semantics for actual server code.
for (const name of [
  'window',
  'document',
  'DOMParser',
  'HTMLElement',
  'Element',
  'Node',
  'Text',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  Object.defineProperty(globalThis, name, {
    value: dom.window[name],
    configurable: true,
    writable: true,
  })
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
