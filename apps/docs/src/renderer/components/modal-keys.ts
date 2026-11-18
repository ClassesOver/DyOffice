import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { createImeEnterGuard, type ImeEnterGuard } from '@genoffice/ui'

const openModals: HTMLDivElement[] = []
const modalParents = new Map<HTMLDivElement, RefObject<HTMLDivElement | null>>()

function belongsBelow(modal: HTMLDivElement, ancestor: HTMLDivElement): boolean {
  const visited = new Set<HTMLDivElement>()
  let current: HTMLDivElement | null = modal
  while (current && !visited.has(current)) {
    if (ancestor.contains(current)) return true
    visited.add(current)
    current = modalParents.get(current)?.current ?? null
  }
  return false
}

/**
 * Shared modal keyboard behavior: Esc closes (stopped so it never reaches
 * global listeners like "exit read mode"), Tab cycles inside the modal, and
 * the first form control gets focus on mount unless something inside is
 * already focused (autoFocus). Spread the returned ref/onKeyDown onto the
 * modal backdrop element.
 */
export function useModalKeys(
  onClose: () => void,
  options?: { parentRef?: RefObject<HTMLDivElement | null> },
) {
  // Portal children must explicitly identify their modal parent. DOM nesting
  // remains supported without options; no React-private ancestry is inspected.
  const parentRef = options?.parentRef
  const ref = useRef<HTMLDivElement>(null)
  const imeGuards = useRef(new WeakMap<EventTarget, ImeEnterGuard>())
  const imeFor = useCallback((target: EventTarget) => {
    let guard = imeGuards.current.get(target)
    if (!guard) {
      guard = createImeEnterGuard()
      imeGuards.current.set(target, guard)
    }
    return guard
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 直接监听组合事件，兼容只接收 ref/onKeyDown 的现有弹窗。
    const start = (e: Event) => { if (e.target) imeFor(e.target).handleCompositionStart() }
    const end = (e: Event) => { if (e.target) imeFor(e.target).handleCompositionEnd() }
    el.addEventListener('compositionstart', start, true)
    el.addEventListener('compositionend', end, true)
    return () => {
      el.removeEventListener('compositionstart', start, true)
      el.removeEventListener('compositionend', end, true)
    }
  }, [imeFor])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Child effects mount first; a containing backdrop belongs below its child.
    if (parentRef) modalParents.set(el, parentRef)
    const child = openModals.findIndex(other => belongsBelow(other, el))
    openModals.splice(child < 0 ? openModals.length : child, 0, el)
    return () => {
      const index = openModals.indexOf(el)
      if (index >= 0) openModals.splice(index, 1)
      modalParents.delete(el)
    }
  }, [parentRef])

  useEffect(() => {
    const el = ref.current
    if (!el || openModals.at(-1) !== el || el.contains(document.activeElement)) return
    const first = [...el.querySelectorAll<HTMLElement>('input, textarea, select, button')]
      .find(control => !control.matches(':disabled') && control.tabIndex >= 0)
    ;(first ?? el).focus()
  }, [])

  // A click on non-focusable content can leave focus on body, outside React's handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openModals.at(-1) !== ref.current || !focusOutsideModal(ref.current)) return
      if (e.key === 'Tab') trapTab(ref.current, e)
      else if (e.key === 'Escape') {
        if (imeFor(e.target ?? window).isImeConfirm(e)) return
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, imeFor])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (openModals.at(-1) !== ref.current) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (imeFor(e.target).isImeConfirm(e.nativeEvent)) return
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Tab') trapTab(ref.current, e)
  }

  return { ref, onKeyDown }
}

export function focusOutsideModal(container: HTMLElement | null): boolean {
  const active = document.activeElement
  return !active || active === document.body || !container?.contains(active)
}

const FOCUSABLE =
  'button, input, textarea, select, a[href], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])'

/** Cycle Tab/Shift+Tab inside a container (pure DOM helper, exported for tests). */
export function trapTab(
  container: HTMLElement | null,
  e: { key: string; shiftKey: boolean; preventDefault: () => void },
): void {
  if (!container || e.key !== 'Tab') return
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0,
  )
  if (items.length === 0) {
    e.preventDefault()
    return
  }
  const first = items[0]!
  const last = items[items.length - 1]!
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !container.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}
