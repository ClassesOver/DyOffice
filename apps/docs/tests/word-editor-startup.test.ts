import { act, createElement, useEffect, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { useWordEditor } from '../src/renderer/editor/use-word-editor'

afterEach(() => vi.useRealTimers())

it('does not expose a destroyed editor when cleanup timers run before passive effects', async () => {
  vi.useFakeTimers()
  const storage: unknown[] = []
  function Document() {
    const editor = useWordEditor({
      extensions: editorExtensions,
      content: { type: 'doc', content: [{ type: 'docParagraph' }] },
    })
    // 模拟浏览器在提交与被动effect之间执行已到期的清理计时器。
    useLayoutEffect(() => { vi.advanceTimersByTime(2) }, [])
    useEffect(() => {
      if (editor) storage.push(editor.storage.trackChanges)
    }, [editor])
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(Document)))
    expect(storage.length).toBeGreaterThan(0)
    expect(storage.every(value => value && typeof value === 'object')).toBe(true)
    expect(storage.at(-1)).toMatchObject({ enabled: false, trackMoves: true, trackFormatting: true })
  } finally {
    await act(async () => root.unmount())
    vi.runOnlyPendingTimers()
    container.remove()
  }
})
