import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { BookmarkModal, CrossRefModal, ChartInsertModal } from '../src/renderer/components/ribbon-insert-tab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const modals = [BookmarkModal, CrossRefModal, ChartInsertModal]
let editor: Editor
let root: Root
let host: HTMLDivElement
const close = vi.fn()

beforeEach(() => {
  close.mockReset()
  editor = new Editor({
    element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Keep document text' }] }] },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); editor.destroy() })

function key(target: EventTarget, name: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}

for (const Modal of modals) describe(Modal.name, () => {
  function open() {
    act(() => root.render(createElement(Modal, { editor, onClose: close })))
    const modal = host.querySelector<HTMLElement>('.modal')!
    const controls = [...modal.querySelectorAll<HTMLElement>('input,button,select,textarea')].filter(el => !el.hasAttribute('disabled'))
    return { modal, first: controls[0]!, last: controls.at(-1)! }
  }

  it('focuses inside, wraps both boundaries and closes on Escape without changing the document', () => {
    const before = editor.getJSON()
    const { modal, first, last } = open()
    expect(modal.contains(document.activeElement)).toBe(true)
    last.focus()
    expect(key(last, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    first.focus()
    expect(key(first, 'Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    expect(key(last, 'Escape').defaultPrevented).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(editor.getJSON()).toEqual(before)
  })

  it('recovers both Tab directions after a click leaves focus on body', () => {
    const { first, last } = open()
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(key(window, 'Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    last.blur()
    expect(key(window, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    expect(close).not.toHaveBeenCalled()
  })
})
