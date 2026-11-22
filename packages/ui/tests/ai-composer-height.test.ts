/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AiComposer } from '../src/AiComposer'

// jsdom has no layout: model a textarea whose wrapped height depends on its width.
let width = 10
const observers: Array<() => void> = []
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void { observers.push(this.callback) }
  disconnect(): void { observers.splice(observers.indexOf(this.callback), 1) }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
    const lines = this.value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil((line.length * 10) / width)), 0)
    return lines * 20 + 4
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observers.length = 0
  width = 10
})

const render = (value: string): HTMLTextAreaElement => {
  act(() => root.render(createElement(AiComposer, {
    value, busy: false, placeholder: '', hintIdle: '', hintBusy: '', sendLabel: 'send', stopLabel: 'stop',
    onChange: () => {}, onSend: () => {}, onStop: () => {},
  })))
  return host.querySelector('textarea')!
}

it('re-measures when the textarea widens after a narrow measure, so a short draft does not stay at maximum height', () => {
  const textarea = render('核对当前文档\n保留这份草稿')
  expect(textarea.style.height).toBe('168px')
  width = 400
  act(() => observers.forEach(callback => callback()))
  expect(textarea.style.height).toBe('44px')
})

it('ignores height-only resizes and clears the inline height for an empty draft', () => {
  const textarea = render('short')
  width = 400
  act(() => observers.forEach(callback => callback()))
  const measured = textarea.style.height
  textarea.style.height = '99px'
  act(() => observers.forEach(callback => callback()))
  expect(textarea.style.height).toBe('99px')
  expect(measured).toBe('24px')
  render('')
  expect(textarea.style.height).toBe('')
  expect(observers.length).toBe(1)
})
