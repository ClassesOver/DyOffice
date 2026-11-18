import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { FindPanel } from '../src/renderer/components/FindPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, editor: Editor
const close = vi.fn()
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} }))
afterAll(() => {
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})
beforeEach(() => {
  close.mockReset()
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0))
  // JSDOM has no scrolling/layout implementation; preserve real editor transactions.
  editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [
      { type: 'docHeading', attrs: { level: 1, bookmarks: ['first'] }, content: [{ type: 'text', text: 'needle first' }] },
      { type: 'docHeading', attrs: { level: 1, bookmarks: ['second'] }, content: [{ type: 'text', text: 'needle second' }] },
    ] } })
  editor.commands.setTextSelection(1)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); editor.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }))
  })
}
function composition(input: HTMLElement, type: string) {
  act(() => { input.dispatchEvent(new CompositionEvent(type, { bubbles: true })) })
}
for (const kind of ['find', 'replace', 'goto-number', 'goto-bookmark'] as const) {
  it.each(['native', 'legacy', 'active', 'just-ended'] as const)(`${kind} ignores IME confirmation (%s), then accepts Enter`, async signal => {
    act(() => root.render(createElement(FindPanel, { editor, onClose: close,
      focusReplaceNonce: kind === 'replace' ? 1 : undefined,
      focusGoToNonce: kind.startsWith('goto') ? 1 : undefined })))
    let input: HTMLInputElement | HTMLSelectElement
    if (kind.startsWith('goto')) {
      change(host.querySelector<HTMLSelectElement>('.find-select')!, kind === 'goto-bookmark' ? 'bookmark' : 'heading')
      input = host.querySelector<HTMLInputElement | HTMLSelectElement>('.find-goto-input')!
      change(input, kind === 'goto-bookmark' ? 'second' : '2')
    } else {
      change(host.querySelector<HTMLInputElement>('.find-input')!, 'needle')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)) })
      expect(host.querySelector('.find-count')?.textContent).toBe('1/2')
      input = host.querySelectorAll<HTMLInputElement>('.find-input')[kind === 'replace' ? 1 : 0]!
      if (kind === 'replace') change(input, 'replacement')
    }
    const before = editor.getJSON(), selection = editor.state.selection.toJSON(), draft = input.value
    const enter = (init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
      act(() => { input.dispatchEvent(event) }); return event
    }
    if (signal === 'active' || signal === 'just-ended') composition(input, 'compositionstart')
    if (signal === 'just-ended') composition(input, 'compositionend')
    const event = enter(signal === 'native' ? { isComposing: true } : signal === 'legacy' ? { keyCode: 229 } : {})
    expect(editor.getJSON()).toEqual(before); expect(editor.state.selection.toJSON()).toEqual(selection)
    if (kind === 'find') expect(host.querySelector('.find-count')?.textContent).toBe('1/2')
    expect(input.value).toBe(draft); expect(close).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false)
    if (signal === 'active') composition(input, 'compositionend')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    enter()
    if (kind === 'replace') expect(editor.getText()).toBe('replacement first\n\nneedle second')
    else if (kind === 'find') expect(host.querySelector('.find-count')?.textContent).toBe('2/2')
    else expect(editor.state.selection.toJSON()).not.toEqual(selection)
  })
}

it('switching away during replacement composition does not disable the reopened field', async () => {
  act(() => root.render(createElement(FindPanel, { editor, onClose: close, focusReplaceNonce: 1 })))
  change(host.querySelector<HTMLInputElement>('.find-input')!, 'needle')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)) })
  const previous = host.querySelectorAll<HTMLInputElement>('.find-input')[1]!
  composition(previous, 'compositionstart')
  const tabs = host.querySelectorAll<HTMLButtonElement>('.find-tab')
  act(() => tabs[2]!.click()); expect(previous.isConnected).toBe(false)
  act(() => tabs[1]!.click())
  const replacement = host.querySelectorAll<HTMLInputElement>('.find-input')[1]!
  change(replacement, 'replacement')
  act(() => replacement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(editor.getText()).toBe('replacement first\n\nneedle second')
})

it('composition in the find field does not block deliberate replacement in its sibling', async () => {
  act(() => root.render(createElement(FindPanel, { editor, onClose: close, focusReplaceNonce: 1 })))
  const search = host.querySelector<HTMLInputElement>('.find-input')!
  change(search, 'needle')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)) })
  composition(search, 'compositionstart')
  const replacement = host.querySelectorAll<HTMLInputElement>('.find-input')[1]!
  change(replacement, 'replacement')
  act(() => replacement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(editor.getText()).toBe('replacement first\n\nneedle second')
})

it('ordinary Shift+Enter still navigates search results backwards', async () => {
  act(() => editor.commands.setContent({ type: 'doc', content: [
    { type: 'docParagraph', content: [{ type: 'text', text: 'needle needle needle' }] },
  ] }))
  act(() => root.render(createElement(FindPanel, { editor, onClose: close })))
  const input = host.querySelector<HTMLInputElement>('.find-input')!
  change(input, 'needle')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)) })
  expect(host.querySelector('.find-count')?.textContent).toBe('1/3')
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })))
  expect(host.querySelector('.find-count')?.textContent).toBe('3/3')
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(host.querySelector('.find-count')?.textContent).toBe('1/3')
})
