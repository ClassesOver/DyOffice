import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { ReferencesTab } from '../src/renderer/components/ribbon-references-tab'
import { t } from '../src/renderer/i18n/locale'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let editor: Editor
let root: Root
let host: HTMLDivElement
const addSource = vi.fn()

function Harness() {
  const [dropdown, setDropdown] = useState<string | null>(null)
  return createElement(ReferencesTab, {
    editor, hasDoc: true, blocks: [], sources: [], dropdown, setDropdown,
    onInsertNote: vi.fn(), onAddSource: addSource,
  })
}
function click(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === text)!
  expect(button).toBeDefined()
  act(() => button.click())
}
function key(target: EventTarget, name: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}
beforeEach(() => {
  addSource.mockReset()
  editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Keep this text' }] }] } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root.render(createElement(Harness)))
})
afterEach(() => { act(() => root.unmount()); host.remove(); editor.destroy() })

for (const kind of ['caption', 'source']) describe(kind, () => {
  function open() {
    if (kind === 'caption') click(t('ribbonCaption'))
    else { click(t('ribbonCitation')); click(t('ribbonAddNewSource')) }
    const modal = host.querySelector<HTMLElement>('.modal')!
    const controls = [...modal.querySelectorAll<HTMLElement>('button,input,select,textarea')].filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0)
    return { modal, first: controls[0]!, last: controls.at(-1)! }
  }
  it('keeps focus inside both boundaries and Escape closes without inserting', () => {
    const before = editor.getJSON(), { modal, first, last } = open()
    expect(modal.contains(document.activeElement)).toBe(true)
    last.focus(); expect(key(last, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    first.focus(); expect(key(first, 'Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    key(last, 'Escape')
    expect(host.querySelector('.modal')).toBeNull()
    expect(editor.getJSON()).toEqual(before)
    expect(addSource).not.toHaveBeenCalled()
  })
  it('lets Escape close the dropdown before the parent modal', () => {
    const { modal } = open()
    const trigger = modal.querySelector<HTMLButtonElement>('.gs-dd-btn')!
    trigger.focus(); act(() => trigger.click())
    expect(modal.querySelector('[role="listbox"]')).not.toBeNull()
    key(trigger, 'Escape')
    expect(modal.querySelector('[role="listbox"]')).toBeNull()
    expect(host.contains(modal)).toBe(true)
    key(trigger, 'Escape')
    expect(host.querySelector('.modal')).toBeNull()
    expect(addSource).not.toHaveBeenCalled()
  })
})
