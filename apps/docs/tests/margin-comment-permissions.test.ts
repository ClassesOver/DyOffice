import { afterEach, expect, it, vi } from 'vitest'
import { clearMarginAnnotations, syncMarginAnnotations } from '../src/renderer/editor/margin-annotations'

let app: HTMLDivElement
function mount() {
  app = document.createElement('div')
  app.className = 'app'
  app.setAttribute('data-comment-cards', '')
  const wrap = document.createElement('div')
  wrap.className = 'page-wrap'
  const pm = document.createElement('div')
  pm.className = 'ProseMirror'
  pm.contentEditable = 'false'
  const anchor = document.createElement('span')
  anchor.className = 'doc-comment'
  anchor.dataset.commentIds = 'c1'
  anchor.textContent = 'Body'
  anchor.getClientRects = () => [{ top: 100, bottom: 116, left: 10, right: 50, height: 16 }] as unknown as DOMRectList
  pm.append(anchor)
  wrap.append(pm)
  app.append(wrap)
  document.body.append(app)
  const onReply = vi.fn(), onEdit = vi.fn(), onDelete = vi.fn(), onResolve = vi.fn(), onBalloon = vi.fn()
  const render = (canComment: boolean) => syncMarginAnnotations(wrap, pm, [
    { id: 'c1', author: 'A', text: 'Original' },
    { id: 'r1', parentId: 'c1', author: 'B', text: 'Existing reply' },
  ], 1, [], undefined, {
    canComment, onCommentReply: onReply, onCommentEdit: onEdit, onCommentDelete: onDelete,
    onCommentResolve: onResolve, onCommentBalloon: onBalloon,
  })
  return { wrap, pm, render, onReply, onEdit, onDelete, onResolve, onBalloon }
}
afterEach(() => {
  const wrap = app?.querySelector<HTMLElement>('.page-wrap')
  if (wrap) clearMarginAnnotations(wrap)
  app?.remove()
})

it('keeps readonly comments and anchor navigation without offering mutation controls', () => {
  const { render, onBalloon } = mount()
  render(false)
  expect([...app.querySelectorAll('.comment-text')].map(el => el.textContent)).toEqual(['Original', 'Existing reply'])
  expect(app.querySelector('.comment-more,.comment-resolve,.comment-like,.comment-reply-input,textarea')).toBeNull()
  app.querySelector<HTMLButtonElement>('.comment-balloon')!.click()
  expect(onBalloon).toHaveBeenCalledWith('c1')
})

it('allows comment-only interaction while the body stays noneditable', () => {
  const { render, pm, onReply } = mount()
  const before = pm.innerHTML
  render(true)
  expect(app.querySelectorAll('.comment-more')).toHaveLength(2)
  const input = app.querySelector<HTMLInputElement>('.comment-reply-input')!
  input.value = 'Permitted'
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(onReply).toHaveBeenCalledWith('c1', 'Permitted')
  expect(pm.innerHTML).toBe(before)
  expect(pm.contentEditable).toBe('false')
})

it('removes a pending editor on permission loss without publishing its draft or reopening it later', () => {
  const { render, onReply, onEdit, onDelete, onResolve } = mount()
  render(true)
  app.querySelector<HTMLButtonElement>('.comment-more')!.click()
  app.querySelector<HTMLButtonElement>('.comment-card-edit')!.click()
  app.querySelector<HTMLTextAreaElement>('.comment-edit-input')!.value = 'Unpublished'
  render(false)
  expect(app.querySelector('.comment-more,.comment-resolve,.comment-like,.comment-reply-input,textarea')).toBeNull()
  expect(app.textContent).toContain('Original')
  for (const handler of [onReply, onEdit, onDelete, onResolve]) expect(handler).not.toHaveBeenCalled()
  render(true)
  expect(app.querySelector('textarea')).toBeNull()
  expect(app.textContent).not.toContain('Unpublished')
})
