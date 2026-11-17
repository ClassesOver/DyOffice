import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { BookmarkModal, LinkInsertModal, TableInsertModal } from '../src/renderer/components/ribbon-insert-tab'
import { ReferencesTab } from '../src/renderer/components/ribbon-references-tab'
import { t } from '../src/renderer/i18n/locale'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, editor: Editor
const close = vi.fn()
function CaptionHarness() {
  const [dropdown, setDropdown] = useState<string | null>(null)
  return createElement(ReferencesTab, { editor, hasDoc: true, blocks: [], sources: [], dropdown, setDropdown,
    onInsertNote: vi.fn(), onAddSource: vi.fn() })
}
beforeEach(() => {
  close.mockReset()
  editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Keep text' }] }] } })
  editor.commands.setTextSelection(1)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); editor.destroy() })
function composition(input: HTMLElement, type: string) {
  act(() => input.dispatchEvent(new CompositionEvent(type, { bubbles: true })))
}
function enter(input: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
  act(() => { input.dispatchEvent(event) })
  return event
}
for (const kind of ['bookmark', 'link', 'table', 'caption'] as const) {
  it.each(['native', 'legacy', 'active', 'just-ended'] as const)(`${kind} does not submit IME confirmation (%s) but accepts the next Enter`, async signal => {
    if (kind === 'caption') {
      act(() => root.render(createElement(CaptionHarness)))
      const button = [...host.querySelectorAll('button')].find(el => el.textContent?.trim() === t('ribbonCaption'))!
      act(() => button.click())
    } else {
      const Modal = kind === 'bookmark' ? BookmarkModal : kind === 'link' ? LinkInsertModal : TableInsertModal
      act(() => root.render(createElement(Modal, { editor, onClose: close })))
    }
    const inputs = host.querySelectorAll<HTMLInputElement>('.modal input')
    const input = inputs[kind === 'link' ? 1 : 0]!
    if (kind !== 'table') act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, kind === 'link' ? 'https://example.com' : '中文草稿')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const draft = input.value, before = editor.getJSON()
    if (signal === 'active' || signal === 'just-ended') composition(input, 'compositionstart')
    if (signal === 'just-ended') composition(input, 'compositionend')
    const event = enter(input, signal === 'native' ? { isComposing: true } : signal === 'legacy' ? { keyCode: 229 } : {})
    expect(event.defaultPrevented).toBe(false)
    expect(editor.getJSON()).toEqual(before)
    expect(input.value).toBe(draft)
    expect(close).not.toHaveBeenCalled()
    expect(host.querySelector('.modal')).not.toBeNull()
    if (signal === 'active') composition(input, 'compositionend')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    enter(input)
    expect(editor.getJSON()).not.toEqual(before)
  })
}
