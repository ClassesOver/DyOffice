import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

const openModals: HTMLDivElement[] = []

/**
 * Shared modal keyboard behavior: Esc closes (stopped so it never reaches
 * global listeners like "exit read mode"), Tab cycles inside the modal, and
 * the first form control gets focus on mount unless something inside is
 * already focused (autoFocus). Spread the returned ref/onKeyDown onto the
 * modal backdrop element.
 */
export function useModalKeys(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Child effects mount first; a containing backdrop belongs below its child.
    const child = openModals.findIndex(other => el.contains(other))
    openModals.splice(child < 0 ? openModals.length : child, 0, el)
    return () => {openModals.splice(openModals.indexOf(el), 1)}
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || el.contains(document.activeElement)) return
    const first = el.querySelector<HTMLElement>('input, textarea, select, button')
    ;(first ?? el).focus()
  }, [])

  // A click on non-focusable content can leave focus on body, outside React's handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openModals.at(-1) !== ref.current || !focusOutsideModal(ref.current)) return
      if (e.key === 'Tab') trapTab(ref.current, e)
      else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (openModals.at(-1) !== ref.current) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
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
