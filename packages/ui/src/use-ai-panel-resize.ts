import { useEffect, useRef, useState, type HTMLAttributes } from 'react'
import {
  AI_PANEL_WIDTH_DEFAULT,
  AI_PANEL_WIDTH_MIN,
  clampAiPanelWidth,
  loadAiPanelWidth,
  maxAiPanelWidth,
  saveAiPanelWidth,
} from './ai-panel-width'

/** Resize the divider relative to where the drag started, including on a zoomed panel. */
export function useAiPanelResize(key: string | undefined, lang: string, open: boolean) {
  const [preferred, setPreferred] = useState(() => (key && loadAiPanelWidth(key)) || AI_PANEL_WIDTH_DEFAULT)
  const [limit, setLimit] = useState(() => key ? maxAiPanelWidth() : AI_PANEL_WIDTH_DEFAULT)
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ id: number; x: number; width: number; factor: number; moved: boolean } | null>(null)
  const width = Math.min(preferred, limit)

  useEffect(() => {
    if (!key) return
    const onResize = () => setLimit(maxAiPanelWidth())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [key])
  useEffect(() => {
    if (open) return
    drag.current = null
    setResizing(false)
  }, [open])

  const direction = () => document.documentElement.dataset.aiPanelSide === 'right' ? -1 : 1
  const finish = (id: number) => {
    if (drag.current?.id !== id) return
    drag.current = null
    setResizing(false)
  }

  const handle: HTMLAttributes<HTMLDivElement> = {
    className: 'ai-panel-width-handle',
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': 'vertical',
    'aria-label': lang.startsWith('zh') ? (lang === 'zh-TW' ? '調整 AI 助手寬度' : '调整 AI 助手宽度') : 'Resize AI assistant',
    'aria-valuemin': AI_PANEL_WIDTH_MIN,
    'aria-valuemax': limit,
    'aria-valuenow': width,
    onPointerDown(event) {
      const panel = event.currentTarget.parentElement
      if (event.button !== 0 || drag.current || !panel?.offsetWidth) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const scale = panel.getBoundingClientRect().width / panel.offsetWidth
      drag.current = { id: event.pointerId, x: event.clientX, width: panel.offsetWidth, factor: direction() / scale, moved: false }
      setResizing(true)
    },
    onPointerMove(event) {
      const start = drag.current
      if (start?.id !== event.pointerId || (!start.moved && event.clientX === start.x)) return
      start.moved = true
      setPreferred(clampAiPanelWidth(Math.round(start.width + (event.clientX - start.x) * start.factor)))
    },
    onPointerUp(event) {
      const start = drag.current
      if (start?.id !== event.pointerId) return
      if (start.moved || event.clientX !== start.x) {
        const next = clampAiPanelWidth(Math.round(start.width + (event.clientX - start.x) * start.factor))
        setPreferred(next)
        if (key) saveAiPanelWidth(key, next)
      }
      finish(event.pointerId)
    },
    onPointerCancel: event => finish(event.pointerId),
    onLostPointerCapture: event => finish(event.pointerId),
    onKeyDown(event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const next = clampAiPanelWidth(width + (event.key === 'ArrowLeft' ? -16 : 16) * direction())
      setPreferred(next)
      if (key) saveAiPanelWidth(key, next)
    },
  }
  return { width, resizing, handle }
}
