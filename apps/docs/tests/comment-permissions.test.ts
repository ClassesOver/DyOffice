import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { CommentInfo } from '@genoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  addCommentAt,
  deleteAllComments,
  deleteComment,
  editComment,
  replyToComment,
  resolveComment,
  startNewComment,
  submitNewComment,
  type ReviewContext,
} from '../src/renderer/review-actions'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))
function setup(canComment: boolean) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          content: [
            {
              type: 'text',
              text: 'hello',
              marks: [{ type: 'comment', attrs: { ids: '1' } }],
            },
          ],
        },
      ],
    },
  })
  editors.push(editor)
  editor.commands.setTextSelection({ from: 1, to: 6 })
  editor.setEditable(false)
  const original: CommentInfo[] = [{ id: '1', author: 'A', text: 'original' }]
  let comments = original
  const dirtyRef = { current: false }
  const dirty = vi.fn(),
    status = vi.fn(),
    compose = vi.fn()
  const ctx = {
    editor,
    canComment,
    get comments() {
      return comments
    },
    dirtyRef,
    setComments: (update: (prev: CommentInfo[]) => CommentInfo[]) => {
      comments = update(comments)
    },
    setCommentsDirty: dirty,
    setStatus: status,
    setCommentComposing: compose,
    setShowComments: vi.fn(),
  } as unknown as ReviewContext
  return { editor, ctx, original, dirty, status, compose }
}
const actions = {
  edit: (ctx: ReviewContext) => editComment(ctx, '1', 'changed'),
  resolve: (ctx: ReviewContext) => resolveComment(ctx, '1', true),
  delete: (ctx: ReviewContext) => deleteComment(ctx, '1'),
  deleteAll: (ctx: ReviewContext) => deleteAllComments(ctx, false),
  reply: (ctx: ReviewContext) => replyToComment(ctx, '1', 'reply', 'B'),
  add: (ctx: ReviewContext) =>
    addCommentAt(ctx, { from: 1, to: 6 }, 'new', 'B'),
  submit: (ctx: ReviewContext) => submitNewComment(ctx, 'new'),
  start: (ctx: ReviewContext) => startNewComment(ctx),
}
describe('comment permission boundary with a real editor', () => {
  it.each(Object.entries(actions))(
    'blocks %s without changing comments, anchors or save dirtiness',
    (_name, action) => {
      const { editor, ctx, original, dirty, status, compose } = setup(false)
      const before = editor.getJSON()
      action(ctx)
      expect(ctx.comments).toEqual(original)
      expect(editor.getJSON()).toEqual(before)
      expect(ctx.dirtyRef.current).toBe(false)
      expect(dirty).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
      expect(compose).not.toHaveBeenCalled()
    },
  )
  it('preserves comment-only protected documents with a noneditable body', () => {
    const { editor, ctx, dirty } = setup(true)
    expect(editor.isEditable).toBe(false)
    expect(replyToComment(ctx, '1', 'reply', 'B')).toBe(true)
    editComment(ctx, '1', 'updated')
    expect(ctx.comments.map((c) => c.text)).toEqual(['updated', 'reply'])
    expect(dirty).toHaveBeenCalledWith(true)
  })
  it('rechecks permission at submission after a composer was opened', () => {
    const { ctx, original } = setup(true)
    startNewComment(ctx)
    ctx.canComment = false
    submitNewComment(ctx, 'late edit')
    expect(ctx.comments).toEqual(original)
    expect(ctx.dirtyRef.current).toBe(false)
  })
})

// The same panel stays mounted when permissions change; discard any open draft.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { CommentsPanel } from '../src/renderer/components/CommentsPanel'
import { LocaleProvider } from '../src/renderer/i18n/locale'
it('keeps readonly comments readable but removes edit/delete/resolve/reply and new composers', () => {
  Object.assign(window, {
    desktop: { onLanguageChanged: () => () => undefined },
  })
  const { editor, original } = setup(false)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const props = {
    comments: original,
    docNode: editor.state.doc,
    composing: true,
    onSubmitNew: vi.fn(),
    onReply: vi.fn(),
    onEdit: vi.fn(),
    onResolve: vi.fn(),
    onCancelNew: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  }
  const render = (canComment: boolean) =>
    act(() =>
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(CommentsPanel, { ...props, canComment }),
        }),
      ),
    )
  try {
    render(true)
    act(() =>
      container.querySelector<HTMLButtonElement>('.comment-more')!.click(),
    )
    act(() =>
      container.querySelector<HTMLButtonElement>('.comment-card-edit')!.click(),
    )
    expect(container.querySelector('.comment-reply-compose')).not.toBeNull()
    render(false)
    expect(container.textContent).toContain('original')
    expect(
      container.querySelector(
        '.comment-more,.comment-resolve,.comment-reply-input,textarea',
      ),
    ).toBeNull()
    expect(container.querySelector('.comments-pane-close')).not.toBeNull()
    const card = container.querySelector<HTMLElement>('.comment-card')!
    expect(card.tabIndex).toBe(0)
    act(() => card.focus())
    expect(document.activeElement).toBe(card)
    act(() => container.querySelector<HTMLButtonElement>('.comments-pane-close')!.click())
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onEdit).not.toHaveBeenCalled()
    render(true)
    expect(container.querySelector('.comment-reply-compose')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it.each([
  ['resolve', (ctx: ReviewContext) => resolveComment(ctx, '1', true)],
  ['remove', (ctx: ReviewContext) => deleteComment(ctx, '1')],
] as const)('%s returns the actual write outcome for AI callers', (_name, action) => {
  const { ctx } = setup(false)
  expect(action(ctx)).toBe(false)
  ctx.canComment = true
  expect(action(ctx)).toBe(true)
})

it.each([false, true])('blocks body history while readonly even when comment permission is %s', (canComment) => {
  const { editor, ctx } = setup(canComment)
  editor.setEditable(true)
  editor.commands.insertContentAt(6, '!')
  editor.setEditable(false)
  const locked = editor.getJSON()
  expect(editor.can().undo()).toBe(false)
  expect(editor.commands.undo()).toBe(false)
  expect(editor.chain().undo().run()).toBe(false)
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
  expect(editor.getJSON()).toEqual(locked)
  if (canComment) expect(replyToComment(ctx, '1', 'allowed reply', 'B')).toBe(true)
  editor.setEditable(true)
  expect(editor.commands.undo()).toBe(true)
})

it('rechecks readonly for redo without losing pending history', () => {
  const { editor } = setup(false)
  editor.setEditable(true)
  editor.commands.insertContentAt(6, '!')
  expect(editor.commands.undo()).toBe(true)
  const undone = editor.getJSON()
  editor.setEditable(false)
  expect(editor.can().redo()).toBe(false)
  expect(editor.commands.redo()).toBe(false)
  expect(editor.chain().redo().run()).toBe(false)
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }))
  expect(editor.getJSON()).toEqual(undone)
  editor.setEditable(true)
  expect(editor.commands.redo()).toBe(true)
  expect(editor.getText()).toBe('hello!')
})
