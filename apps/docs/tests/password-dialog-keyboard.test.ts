import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PasswordDialog } from '../src/renderer/components/PasswordDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const cancel = vi.fn(), submit = vi.fn()
beforeEach(() => { cancel.mockReset(); submit.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
function open(busy = false) {
  act(() => root.render(createElement(PasswordDialog, {
    title: '修改密码', body: '输入密码或只读打开', label: '密码', value: 'draft', error: '', busy,
    submitLabel: '确定', cancelLabel: '只读打开', onChange: vi.fn(), onSubmit: submit, onCancel: cancel,
  })))
  const controls = [...host.querySelectorAll<HTMLElement>('input,button')].filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0)
  return { first: controls[0]!, last: controls.at(-1)! }
}
function key(target: EventTarget, name: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) }); return event
}
describe('document password prompt keyboard', () => {
  it('wraps both directions and Escape uses the existing cancel action without submitting', () => {
    const { first, last } = open()
    expect(document.activeElement).toBe(first)
    last.focus(); expect(key(last, 'Tab').defaultPrevented).toBe(true); expect(document.activeElement).toBe(first)
    first.focus(); expect(key(first, 'Tab', true).defaultPrevented).toBe(true); expect(document.activeElement).toBe(last)
    key(last, 'Escape'); expect(cancel).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled()
  })
  it('focuses the enabled cancel action while busy and recovers outside focus', () => {
    const { first, last } = open(true)
    expect(first).toBe(last)
    expect(document.activeElement).toBe(first)
    first.blur(); key(window, 'Tab', true); expect(document.activeElement).toBe(first)
    key(first, 'Escape'); expect(cancel).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled()
  })
})
