import { act, createElement as h, StrictMode } from 'react'
import type { RefObject, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { it, expect, vi } from 'vitest'
import { useModalKeys } from '../src/renderer/components/modal-keys'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function Modal({
  close,
  id,
  children,
  parentRef,
}: {
  close: () => void
  id: string
  children?: ReactNode | ((ref: RefObject<HTMLDivElement | null>) => ReactNode)
  parentRef?: RefObject<HTMLDivElement | null>
}) {
  const keys = useModalKeys(close, { parentRef })
  return h(
    'div',
    { ...keys, 'data-id': id },
    h('input', { 'data-input': id }),
    typeof children === 'function' ? children(keys.ref) : children,
  )
}
const event = (target: Element, key = 'Escape', opts = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  act(() => target.dispatchEvent(e))
  return e
}
for (const portal of [false, true])
  for (const signal of ['native', 'legacy', 'active', 'ended'])
    it(`nested ownership portal=${portal} signal=${signal}`, async () => {
      const host = document.body.appendChild(document.createElement('div')),
        portalHost = document.body.appendChild(document.createElement('div')),
        root = createRoot(host),
        outer = vi.fn(),
        inner = vi.fn(),
        global = vi.fn()
      const render = (child: boolean) =>
        act(() =>
          root.render(
            h(
              StrictMode,
              {},
              h(Modal, {
                close: outer,
                id: 'outer',
                children: child
                  ? (parentRef: RefObject<HTMLDivElement | null>) =>
                      portal
                        ? createPortal(
                            h(Modal, { close: inner, id: 'inner', parentRef }),
                            portalHost,
                          )
                        : h(Modal, { close: inner, id: 'inner', parentRef })
                  : null,
              }),
            ),
          ),
        )
      try {
        render(true)
        const input = document.querySelector('[data-input="inner"]') as HTMLInputElement
        expect(document.activeElement).toBe(input)
        input.focus()
        window.addEventListener('keydown', global)
        if (signal === 'active' || signal === 'ended')
          act(() =>
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
          )
        if (signal === 'ended')
          act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
        const e = event(
          input,
          'Escape',
          signal === 'native' ? { isComposing: true } : signal === 'legacy' ? { keyCode: 229 } : {},
        )
        expect(inner).not.toHaveBeenCalled()
        expect(outer).not.toHaveBeenCalled()
        expect(global).not.toHaveBeenCalled()
        expect(e.defaultPrevented).toBe(false)
        if (signal === 'active')
          act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
        await act(async () => {
          await new Promise((r) => setTimeout(r, 5))
        })
        expect(event(input).defaultPrevented).toBe(true)
        expect(inner).toHaveBeenCalledTimes(1)
        expect(outer).not.toHaveBeenCalled()
        render(false)
        const remaining = host.querySelector('input')!
        remaining.focus()
        event(remaining)
        expect(outer).toHaveBeenCalledTimes(1)
      } finally {
        window.removeEventListener('keydown', global)
        act(() => root.unmount())
        host.remove()
        portalHost.remove()
      }
    })
it('composition on one field does not poison Escape on a different focused control', () => {
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host),
    close = vi.fn()
  try {
    act(() => root.render(h(Modal, { id: 'one', close }, h('button', {}, 'close'))))
    const input = host.querySelector('input')!,
      button = host.querySelector('button')!
    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    button.focus()
    event(button)
    expect(close).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
it('explicit portal parent preserves BODY fallback, Tab and lower ownership after unmount', () => {
  const host = document.body.appendChild(document.createElement('div')),
    portal = document.body.appendChild(document.createElement('div')),
    root = createRoot(host),
    outer = vi.fn(),
    inner = vi.fn()
  const render = (child: boolean) =>
    act(() =>
      root.render(
        h(Modal, {
          close: outer,
          id: 'outer',
          children: child
            ? (parentRef: RefObject<HTMLDivElement | null>) =>
                createPortal(h(Modal, { close: inner, id: 'inner', parentRef }), portal)
            : null,
        }),
      ),
    )
  try {
    render(true)
    const input = portal.querySelector('input')!
    expect(document.activeElement).toBe(input)
    input.blur()
    event(document.body, 'Tab')
    expect(document.activeElement).toBe(input)
    input.blur()
    event(document.body, 'Escape', { isComposing: true })
    expect(inner).not.toHaveBeenCalled()
    event(document.body)
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
    render(false)
    event(document.body, 'Tab')
    expect(document.activeElement).toBe(host.querySelector('input'))
    event(host.querySelector('input')!)
    expect(outer).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
    portal.remove()
  }
})
it('three explicit portal levels keep the deepest owner through whole-tree teardown', () => {
  const host = document.body.appendChild(document.createElement('div'))
  const portal = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const closes = [vi.fn(), vi.fn(), vi.fn()]
  const tree = (level: number, parentRef?: RefObject<HTMLDivElement | null>): any =>
    h(Modal, {
      id: `level-${level}`,
      close: closes[level]!,
      parentRef,
      children:
        level < 2
          ? (ref: RefObject<HTMLDivElement | null>) => createPortal(tree(level + 1, ref), portal)
          : null,
    })
  try {
    act(() => root.render(tree(0)))
    const deepest = portal.querySelector('[data-input="level-2"]')!
    expect(document.activeElement).toBe(deepest)
    event(deepest)
    expect(closes[2]).toHaveBeenCalledOnce()
    expect(closes[0]).not.toHaveBeenCalled()
    expect(closes[1]).not.toHaveBeenCalled()
    act(() => root.render(null))
    act(() => root.render(h(Modal, { id: 'fresh', close: closes[0]! })))
    event(host.querySelector('input')!)
    expect(closes[0]).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
    portal.remove()
  }
})
