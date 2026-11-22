/**
 * Focus contract between editor hosts and the assistant panel.
 *
 * Every editor host (Univer, Tiptap, the slide canvas, the PDF view) has its
 * own logic that moves keyboard focus back into the document. While the user
 * is typing in the assistant, or moving between its tabs and cards, that
 * logic must not take the keyboard away. Instead of each host keeping its
 * own list of assistant selectors, the assistant registers its root element
 * here and hosts ask `assistantHoldsKeyboard()` before refocusing.
 *
 * The registry is per document (module scope), holds only connected roots,
 * and never moves focus itself.
 */
import { useCallback, useRef } from 'react'

const roots = new Set<Element>()

/** Register an assistant root; returns the unregister function. */
export function registerAssistantFocusRoot(root: Element): () => void {
  roots.add(root)
  return () => {
    roots.delete(root)
  }
}

/** True when the focused element (default: `document.activeElement`) is inside a registered assistant. */
export function assistantHoldsKeyboard(active: Element | null = globalThis.document?.activeElement ?? null): boolean {
  if (!active || active === active.ownerDocument?.body) return false
  for (const root of roots) if (root.isConnected && root.contains(active)) return true
  return false
}

/** React ref callback that keeps the element registered while it is mounted. */
export function useAssistantFocusRoot<T extends Element>(): (element: T | null) => void {
  const release = useRef<(() => void) | undefined>(undefined)
  return useCallback((element: T | null) => {
    release.current?.()
    release.current = element ? registerAssistantFocusRoot(element) : undefined
  }, [])
}
