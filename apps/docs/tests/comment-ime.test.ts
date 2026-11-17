import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { CommentsPanel } from '../src/renderer/components/CommentsPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement, editor: Editor
const submit = vi.fn(), reply = vi.fn(), edit = vi.fn()
beforeEach(() => {
  submit.mockReset(); reply.mockReset(); edit.mockReset()
  editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph' }] } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); editor.destroy() })
function composition(input: HTMLElement, type: string) {
  act(() => { input.dispatchEvent(new CompositionEvent(type, { bubbles: true })) })
}
for (const kind of ['new-ctrl', 'new-meta', 'edit-ctrl', 'edit-meta', 'reply'] as const) {
  it.each(['native', 'legacy', 'active', 'just-ended'] as const)(`${kind} keeps IME draft (%s), then submits deliberately`, async signal => {
    act(() => root.render(createElement(CommentsPanel, {
      comments: [{ id: 'c1', author: 'A', text: 'Original', done: false }], docNode: editor.state.doc,
      composing: kind.startsWith('new'), onSubmitNew: submit, onReply: reply, onEdit: edit,
      onResolve: vi.fn(), onCancelNew: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
    })))
    if (kind.startsWith('edit')) {
      act(() => host.querySelector<HTMLButtonElement>('.comment-more')!.click())
      act(() => host.querySelector<HTMLButtonElement>('.comment-card-edit')!.click())
    }
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(kind === 'reply' ? '.comment-reply-input' : kind.startsWith('new') ? '.comment-compose textarea' : '.comment-reply-compose textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(kind === 'reply' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '中文草稿')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const before = editor.getJSON()
    const enter = (init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true,
        ctrlKey: kind.endsWith('ctrl'), metaKey: kind.endsWith('meta'), ...init })
      act(() => { input.dispatchEvent(event) }); return event
    }
    if (signal === 'active' || signal === 'just-ended') composition(input, 'compositionstart')
    if (signal === 'just-ended') composition(input, 'compositionend')
    const event = enter(signal === 'native' ? { isComposing: true } : signal === 'legacy' ? { keyCode: 229 } : {})
    expect(submit).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled()
    expect(input.isConnected).toBe(true); expect(input.value).toBe('中文草稿')
    expect(event.defaultPrevented).toBe(false); expect(editor.getJSON()).toEqual(before)
    if (signal === 'active') composition(input, 'compositionend')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    enter()
    if (kind === 'reply') { expect(reply).toHaveBeenCalledExactlyOnceWith('c1', '中文草稿'); expect(input.value).toBe('') }
    else if (kind.startsWith('edit')) { expect(edit).toHaveBeenCalledExactlyOnceWith('c1', '中文草稿'); expect(input.isConnected).toBe(false) }
    else { expect(submit).toHaveBeenCalledExactlyOnceWith('中文草稿', undefined); expect(input.value).toBe('') }
  })
}

for (const kind of ['new', 'edit', 'reply'] as const) {
  it(`${kind} does not retain composition after its input is removed`, () => {
    const render = (visible: boolean) => act(() => root.render(createElement(CommentsPanel, {
      comments: visible ? [{ id: 'c1', author: 'A', text: 'Original', done: false }] : [],
      docNode: editor.state.doc, composing: kind === 'new' && visible,
      onSubmitNew: submit, onReply: reply, onEdit: edit, onResolve: vi.fn(),
      onCancelNew: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
    })))
    const getInput = () => {
      if (kind === 'edit') {
        act(() => host.querySelector<HTMLButtonElement>('.comment-more')!.click())
        act(() => host.querySelector<HTMLButtonElement>('.comment-card-edit')!.click())
      }
      return host.querySelector<HTMLInputElement | HTMLTextAreaElement>(kind === 'reply' ? '.comment-reply-input' : kind === 'new' ? '.comment-compose textarea' : '.comment-reply-compose textarea')!
    }
    render(true); const previous = getInput(); composition(previous, 'compositionstart')
    render(false); expect(previous.isConnected).toBe(false)
    // Editing the same ID twice toggles edit mode; use its normal Escape cancellation.
    if (kind === 'edit') {
      render(true)
      act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    } else render(true)
    const input = getInput()
    act(() => {
      Object.getOwnPropertyDescriptor(kind === 'reply' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'New draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: kind !== 'reply', bubbles: true, cancelable: true })) })
    if (kind === 'new') expect(submit).toHaveBeenCalledExactlyOnceWith('New draft', undefined)
    else if (kind === 'edit') expect(edit).toHaveBeenCalledExactlyOnceWith('c1', 'New draft')
    else expect(reply).toHaveBeenCalledExactlyOnceWith('c1', 'New draft')
  })
}

it('reply composition is scoped to its own thread input', () => {
  act(() => root.render(createElement(CommentsPanel, {
    comments: ['c1', 'c2'].map(id => ({ id, author: 'A', text: 'Thread', done: false })),
    docNode: editor.state.doc, composing: false, onSubmitNew: submit, onReply: reply,
    onEdit: edit, onResolve: vi.fn(), onCancelNew: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
  })))
  const inputs = host.querySelectorAll<HTMLInputElement>('.comment-reply-input')
  composition(inputs[0]!, 'compositionstart')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[1], 'Other thread')
    inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => inputs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(reply).toHaveBeenCalledExactlyOnceWith('c2', 'Other thread')
})
