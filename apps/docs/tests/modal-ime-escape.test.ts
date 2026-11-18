import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useModalKeys } from '../src/renderer/components/modal-keys'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function Modal({ close, version = 0 }: { close: () => void; version?: number }) {
  const keys = useModalKeys(close)
  // Exercise consumers that pass only the existing ref and keyboard handler.
  return createElement('div', { ref: keys.ref, onKeyDown: keys.onKeyDown }, createElement('input', { key: version, defaultValue: 'Draft' }))
}
for (const outside of [false, true]) {
  const signals = outside ? ['native', 'legacy'] as const : ['native', 'legacy', 'active', 'just-ended'] as const
  it.each(signals)(`IME Escape preserves modal and default action (outside=${outside}, %s)`, async signal => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host), close = vi.fn(), globalKey = vi.fn()
    try {
      act(() => root.render(createElement(Modal, { close })))
      const input = host.querySelector('input')!
      const target = outside ? document.body : input
      if (outside) input.blur()
      const composition = (type: string) => act(() => { input.dispatchEvent(new CompositionEvent(type, { bubbles: true })) })
      if (signal === 'active' || signal === 'just-ended') composition('compositionstart')
      if (signal === 'just-ended') composition('compositionend')
      window.addEventListener('keydown', globalKey)
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true,
        ...(signal === 'native' ? { isComposing: true } : signal === 'legacy' ? { keyCode: 229 } : {}) })
      act(() => { target.dispatchEvent(event) })
      expect(close).not.toHaveBeenCalled(); expect(input.value).toBe('Draft'); expect(event.defaultPrevented).toBe(false)
      if (!outside) expect(globalKey).not.toHaveBeenCalled()
      if (signal === 'active') composition('compositionend')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
      act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      expect(close).toHaveBeenCalledOnce()
    } finally { window.removeEventListener('keydown', globalKey); act(() => root.unmount()); host.remove() }
  })
}

it('replacing an input during composition leaves the new input Escape usable', () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), close = vi.fn()
  try {
    act(() => root.render(createElement(Modal, { close, version: 0 })))
    const old = host.querySelector('input')!
    act(() => { old.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    act(() => root.render(createElement(Modal, { close, version: 1 })))
    const input = host.querySelector('input')!
    expect(old.isConnected).toBe(false)
    input.focus()
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(close).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); host.remove() }
})
