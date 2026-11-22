/**
 * Keep keyboard focus in app chrome when Univer re-anchors its cell editor.
 *
 * Univer's editor bridge `setEditCell` DOM-focuses the hidden cell editor
 * whenever no Univer editor is logically focused. It runs on every selection
 * set, including the one a render controller replays when it is created late
 * (a workbook finishing its deferred load, a render module registering after
 * mount). If the user is typing in the assistant composer or moving between
 * its tabs at that moment, focus jumps into the grid and the keystrokes
 * land in cells (the office-dock "tasks tab is not focused" failure).
 *
 * After such a call, give focus back to the chrome element that held it,
 * unless the user has just pointed into or typed in the grid: a click on a
 * cell must still move focus into the workbook.
 */
import { IEditorBridgeService } from '@univerjs/sheets-ui'

import type { UniverRuntime } from './univer-state'

/** A pointer press this recent inside the workbook means the user moved there on purpose. */
const GRID_INTENT_MS = 800

interface Bridge {
  setEditCell(param: unknown): void
}

export function chromeHoldsFocus(active: Element | null, container: Element | null): active is HTMLElement {
  return (
    active instanceof HTMLElement &&
    active !== document.body &&
    active.isConnected &&
    !(container?.contains(active) ?? false) &&
    !active.closest('#univer-container')
  )
}

/** Exported for tests: wraps a bridge in place and returns the undo. */
export function guardEditorBridge(
  bridge: Bridge,
  options: { container: () => Element | null; now?: () => number; target?: Pick<Document, 'addEventListener' | 'removeEventListener'> },
): { dispose(): void } {
  const now = options.now ?? (() => performance.now())
  const target = options.target ?? document
  let gridIntentAt = Number.NEGATIVE_INFINITY
  const markIntent = (event: Event): void => {
    const node = event.target
    const container = options.container()
    if (node instanceof Node && (container?.contains(node) || (node instanceof Element && node.closest('#univer-container'))))
      gridIntentAt = now()
  }
  target.addEventListener('pointerdown', markIntent, true)
  target.addEventListener('mousedown', markIntent, true)
  const original = bridge.setEditCell
  bridge.setEditCell = function (this: Bridge, param: unknown): void {
    const active = document.activeElement
    const holder = chromeHoldsFocus(active, options.container()) ? active : null
    original.call(this, param)
    if (!holder || document.activeElement === holder || !holder.isConnected) return
    if (now() - gridIntentAt < GRID_INTENT_MS) return
    holder.focus({ preventScroll: true })
  }
  return {
    dispose() {
      bridge.setEditCell = original
      target.removeEventListener('pointerdown', markIntent, true)
      target.removeEventListener('mousedown', markIntent, true)
    },
  }
}

export function installChromeFocusGuard(runtime: UniverRuntime): { dispose(): void } {
  const bridge = runtime.univer.__getInjector().get(IEditorBridgeService) as unknown as Bridge
  return guardEditorBridge(bridge, { container: () => document.getElementById('univer-container') })
}
