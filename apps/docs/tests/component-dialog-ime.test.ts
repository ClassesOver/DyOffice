import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { FieldDialog } from '../src/renderer/components/FieldDialog'
import { PromptModal } from '../src/renderer/components/PromptModal'
import { WatermarkDialog } from '../src/renderer/components/WatermarkDialog'
import { EquationModal } from '../src/renderer/components/EquationModal'
import { StyleDialog, formValuesOf } from '../src/renderer/components/StyleDialog'
import { PasswordDialog } from '../src/renderer/components/PasswordDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
let editor: Editor
const submit = vi.fn()
const close = vi.fn()
beforeEach(() => {
  submit.mockReset()
  close.mockReset()
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph' }] },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  editor.destroy()
})
function composition(input: HTMLElement, type: string) {
  act(() => {
    input.dispatchEvent(new CompositionEvent(type, { bubbles: true }))
  })
}
function enter(input: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    input.dispatchEvent(event)
  })
  return event
}
for (const kind of [
  'field',
  'prompt',
  'prompt-ctrl',
  'prompt-meta',
  'watermark',
  'equation',
  'style',
  'password',
] as const) {
  it.each(['native', 'legacy', 'active', 'just-ended'] as const)(
    `${kind} preserves the draft on IME confirmation (%s), then submits on Enter`,
    async (signal) => {
      act(() => {
        switch (kind) {
          case 'field':
            root.render(
              createElement(FieldDialog, { instr: 'PAGE', onSubmit: submit, onClose: close }),
            )
            break
          case 'prompt':
          case 'prompt-ctrl':
          case 'prompt-meta':
            root.render(
              createElement(PromptModal, {
                title: '提示',
                initial: '中文草稿',
                multiline: kind !== 'prompt',
                onSubmit: submit,
                onClose: close,
              }),
            )
            break
          case 'watermark':
            root.render(
              createElement(WatermarkDialog, {
                current: { text: '中文水印', style: null, picture: null },
                presets: [],
                pageBox: null,
                onApply: submit,
                onClose: close,
              }),
            )
            break
          case 'equation':
            root.render(createElement(EquationModal, { editor, onClose: close }))
            break
          case 'style':
            root.render(
              createElement(StyleDialog, {
                target: null,
                initial: formValuesOf({ styleId: 'Test', name: '中文样式', type: 'paragraph' }),
                styles: new Map(),
                pending: {},
                onSubmit: submit,
                onClose: close,
              }),
            )
            break
          case 'password':
            root.render(
              createElement(PasswordDialog, {
                title: '密码',
                body: '解锁',
                label: '密码',
                value: 'synthetic-secret',
                error: '',
                submitLabel: '确定',
                cancelLabel: '取消',
                onChange: vi.fn(),
                onSubmit: submit,
                onCancel: close,
              }),
            )
            break
        }
      })
      const selector =
        kind === 'watermark'
          ? 'input[list="wm-text-presets"]'
          : kind.startsWith('prompt-')
            ? 'textarea'
            : 'input'
      const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
      expect(input).not.toBeNull()
      if (kind === 'equation')
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            'x^2',
          )
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
      const draft = input.value
      const before = editor.getJSON()
      const modifier =
        kind === 'prompt-ctrl' ? { ctrlKey: true } : kind === 'prompt-meta' ? { metaKey: true } : {}
      if (signal === 'active' || signal === 'just-ended') composition(input, 'compositionstart')
      if (signal === 'just-ended') composition(input, 'compositionend')
      const event = enter(input, {
        ...modifier,
        ...(signal === 'native'
          ? { isComposing: true }
          : signal === 'legacy'
            ? { keyCode: 229 }
            : {}),
      })
      expect(event.defaultPrevented).toBe(false)
      expect(submit).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
      expect(editor.getJSON()).toEqual(before)
      expect(input.value).toBe(draft)
      expect(host.querySelector('.modal')).not.toBeNull()
      if (signal === 'active') composition(input, 'compositionend')
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      enter(input, modifier)
      if (kind === 'equation') {
        expect(editor.getJSON()).not.toEqual(before)
        expect(close).toHaveBeenCalledTimes(1)
      } else {
        expect(submit).toHaveBeenCalledTimes(1)
      }
    },
  )
}
