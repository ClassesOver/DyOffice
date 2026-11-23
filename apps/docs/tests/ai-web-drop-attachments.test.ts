import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { beforeAll, expect, it, vi } from 'vitest'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createWebAttachments } from '../../web/src/editors/web-attachments'
import { createFilesSkill } from '../src/renderer/ai/files-skill'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(AI_PROVIDERS.map(p => [p.id, { apiKey: '', model: p.defaultModel }])) as AiSettings['providers'],
}

beforeAll(() => { Element.prototype.scrollTo ??= () => {} })

it('Web transport accepts a dropped attachment and exposes its parsed text to read_attachment', async () => {
  const request = vi.fn(async () => ({ ok: true, kind: 'text', text: 'Quarterly revenue: 42' }))
  const attachments = createWebAttachments(request as Parameters<typeof createWebAttachments>[0])
  const previous = window.desktop
  window.desktop = attachments as unknown as typeof window.desktop
  const editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', attrs: { docxIndex: 0 } }] } })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(AiPanel, {
      editor, blocks: [], settings, open: true,
      transport: { stream: () => ({ cancel() {} }) },
    })))
    const panel = container.querySelector('.ai-panel')!
    const file = new File(['Quarterly revenue: 42'], 'quarterly.txt', { type: 'text/plain' })
    const drag = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(drag, 'dataTransfer', { value: { types: ['Files'], files: [file] } })
    act(() => panel.dispatchEvent(drag))
    expect(drag.defaultPrevented).toBe(true)
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
    await act(async () => { panel.dispatchEvent(drop); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(container.querySelector('.ai-attachments')?.textContent).toContain('quarterly.txt')
    expect(request).toHaveBeenCalledWith(
      '/api/v1/ai/attachments/parse?name=quarterly.txt', 'POST', file, expect.any(AbortSignal),
    )
    const path = attachments.getPathForFile(file)
    const skill = createFilesSkill(() => [{ path, name: file.name, ext: 'txt', sizeBytes: file.size }])
    const result = await skill.executeTool({ id: 'read-dropped', name: 'read_attachment', input: { index: 0 } })
    expect(result.isError).not.toBe(true)
    expect(result.output).toContain('Quarterly revenue: 42')
  } finally {
    act(() => root.unmount())
    container.remove(); editor.destroy(); attachments.dispose(); window.desktop = previous
  }
})
