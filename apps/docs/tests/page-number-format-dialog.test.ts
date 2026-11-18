import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PageNumberFormatDialog } from '../src/renderer/components/PageNumberFormatDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
const apply = vi.fn()
function Harness() {
  const [open, setOpen] = useState(true)
  const [value, setValue] = useState({ fmt: 'decimal', start: '' })
  return open ? createElement(PageNumberFormatDialog, { value, sectionCount: 2, activeSection: 0,
    onChange: setValue, onApply: apply, onClose: () => setOpen(false) }) : null
}
function key(target: EventTarget, name: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}
beforeEach(() => {
  apply.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root.render(createElement(Harness)))
})
afterEach(() => { act(() => root.unmount()); host.remove() })
it('focuses inside, traps both boundaries and cancels without applying', () => {
  const modal = host.querySelector('.modal')!
  const controls = modal.querySelectorAll<HTMLElement>('button,input')
  const first = controls[0]!, last = controls[controls.length - 1]!
  expect(modal.contains(document.activeElement)).toBe(true)
  last.focus(); expect(key(last, 'Tab').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(first)
  first.focus(); expect(key(first, 'Tab', true).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(last)
  key(last, 'Escape')
  expect(host.querySelector('.modal')).toBeNull()
  expect(apply).not.toHaveBeenCalled()
})
it('closes the number-format dropdown before closing the parent on a second Escape', () => {
  const modal = host.querySelector('.modal')!, trigger = modal.querySelector<HTMLButtonElement>('.gs-dd-btn')!
  trigger.focus(); act(() => trigger.click())
  expect(modal.querySelector('[role="listbox"]')).not.toBeNull()
  key(trigger, 'Escape')
  expect(modal.querySelector('[role="listbox"]')).toBeNull()
  expect(host.contains(modal)).toBe(true)
  key(trigger, 'Escape')
  expect(host.querySelector('.modal')).toBeNull()
  expect(apply).not.toHaveBeenCalled()
})
