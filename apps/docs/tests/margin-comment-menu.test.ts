import { afterEach, expect, it, vi } from 'vitest'
import type { CommentInfo } from '@genoffice/docx-engine'
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
  const anchor = document.createElement('span')
  anchor.className = 'doc-comment'
  anchor.dataset.commentIds = 'c1 c2'
  anchor.getClientRects = () => [{ top: 100, bottom: 116, left: 10, right: 50, height: 16 }] as unknown as DOMRectList
  pm.append(anchor)
  wrap.append(pm)
  app.append(wrap)
  document.body.append(app)
  const onDelete = vi.fn()
  const initial: CommentInfo[] = [{ id: 'c1', author: 'A', text: 'Comment' }]
  const render = (comments = initial) => syncMarginAnnotations(wrap, pm, comments, 1, [], undefined, {
    onCommentEdit: vi.fn(), onCommentDelete: onDelete,
  })
  render()
  const more = wrap.querySelector<HTMLButtonElement>('.comment-more')!
  const menu = wrap.querySelector<HTMLDivElement>('.comment-menu')!
  const items = [...menu.querySelectorAll<HTMLButtonElement>('button')]
  return { wrap, render, more, menu, items, onDelete }
}
const press = (target: HTMLElement, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
afterEach(() => {
  const wrap = app?.querySelector<HTMLElement>('.page-wrap')
  if (wrap) clearMarginAnnotations(wrap)
  app?.remove()
  document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  vi.restoreAllMocks()
})

it('reports a closed menu before first opening and focuses its first action on click', () => {
  const { more, menu, items } = mount()
  expect(more.getAttribute('aria-expanded')).toBe('false')
  more.click()
  expect(menu.hidden).toBe(false)
  expect(more.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(items[0])
})

it.each(['ArrowDown', 'ArrowUp'])('opens the margin menu with %s', key => {
  const { more, menu, items } = mount()
  more.focus()
  const event = press(more, key)
  expect(menu.hidden).toBe(false)
  expect(document.activeElement).toBe(key === 'ArrowDown' ? items[0] : items.at(-1))
  expect(event.defaultPrevented).toBe(true)
})

it('navigates actions with arrows, Home and End without escaping to the document', () => {
  const { more, items } = mount()
  const leaked = vi.fn()
  app.addEventListener('keydown', leaked)
  more.click()
  for (const [key, index] of [['ArrowUp', 1], ['ArrowDown', 0], ['End', 1], ['Home', 0]] as const) {
    const event = press(document.activeElement as HTMLElement, key)
    expect(document.activeElement).toBe(items[index])
    expect(event.defaultPrevented).toBe(true)
  }
  expect(leaked).not.toHaveBeenCalled()
})

it.each(['Escape', 'Tab'])('%s closes the menu and restores the trigger', key => {
  const { more, menu, items } = mount()
  more.click()
  items[0].focus()
  const event = press(items[0], key)
  expect(menu.hidden).toBe(true)
  expect(document.activeElement).toBe(more)
  expect(more.getAttribute('aria-expanded')).toBe('false')
  expect(event.defaultPrevented).toBe(key === 'Escape')
})

it('closes on focus moving outside the action menu', () => {
  const { more, menu } = mount()
  more.click()
  const outside = document.createElement('button')
  app.append(outside)
  outside.focus()
  expect(menu.hidden).toBe(true)
  expect(document.activeElement).toBe(outside)
})

it('closes before deleting even when the handler does not redraw the card', () => {
  const { more, menu, items, onDelete } = mount()
  more.click()
  items[1].click()
  expect(onDelete).toHaveBeenCalledWith('c1')
  expect(menu.hidden).toBe(true)
})

it.each(['redraw', 'clear'])('removes open-menu document listeners on %s', operation => {
  const { wrap, render, more } = mount()
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  more.click()
  const registered = add.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'focusin')
  try {
    expect(registered.some(([type]) => type === 'pointerdown')).toBe(true)
    if (operation === 'redraw') render()
    else clearMarginAnnotations(wrap)
    for (const [type, listener, options] of registered) {
      expect(remove).toHaveBeenCalledWith(type, listener, options)
    }
  } finally {
    for (const [type, listener, options] of registered) document.removeEventListener(type, listener, options)
  }
})

it.each(['native', 'legacy'] as const)('preserves the focused menu on IME Escape (%s)', signal => {
  const { more, menu, items } = mount()
  const leaked = vi.fn()
  app.addEventListener('keydown', leaked)
  more.click()
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true,
    ...(signal === 'native' ? { isComposing: true } : { keyCode: 229 }) })
  items[0].dispatchEvent(event)
  expect(menu.hidden).toBe(false)
  expect(document.activeElement).toBe(items[0])
  expect(event.defaultPrevented).toBe(false)
  expect(leaked).not.toHaveBeenCalled()
  press(items[0], 'Escape')
  expect(menu.hidden).toBe(true)
  expect(document.activeElement).toBe(more)
})

it('keeps the open menu and its focused action across a pagination redraw', () => {
  const { render, more, items } = mount()
  more.click()
  press(items[0], 'ArrowUp')
  render()
  const menu = app.querySelector<HTMLElement>('.comment-menu')!
  const current = menu.querySelector<HTMLButtonElement>('.comment-card-del')!
  expect(menu.hidden).toBe(false)
  expect(document.activeElement).toBe(current)
  press(current, 'Escape')
  expect(menu.hidden).toBe(true)
  expect(document.activeElement).toBe(app.querySelector('.comment-more'))
})

it.each(['comment-more', 'comment-like'])('keeps focus on %s across a pagination redraw', cls => {
  const { render } = mount()
  app.querySelector<HTMLButtonElement>(`.${cls}`)!.focus()
  render()
  expect(document.activeElement).toBe(app.querySelector(`.${cls}`))
})


it('restores the reply action after threads reorder and reattaches outside dismissal', () => {
  const { render } = mount()
  const first: CommentInfo = { id: 'c1', author: 'A', text: 'First' }
  const second: CommentInfo = { id: 'c2', author: 'B', text: 'Second' }
  const reply: CommentInfo = { id: 'r1', parentId: 'c1', author: 'C', text: 'Reply' }
  render([first, reply, second])
  const entry = () => app.querySelector<HTMLElement>('[data-entry-id="r1"]')!
  entry().querySelector<HTMLButtonElement>('.comment-more')!.click()
  entry().querySelector<HTMLButtonElement>('.comment-card-del')!.focus()
  render([second, first, reply])
  expect(document.activeElement).toBe(entry().querySelector('.comment-card-del'))
  expect(entry().querySelector<HTMLElement>('.comment-menu')!.hidden).toBe(false)
  expect(app.querySelector<HTMLElement>('[data-entry-id="c2"] .comment-menu')!.hidden).toBe(true)
  document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(entry().querySelector<HTMLElement>('.comment-menu')!.hidden).toBe(true)
})

it('does not transfer menu focus to another thread when the focused thread disappears', () => {
  const { render, more } = mount()
  more.click()
  render([{ id: 'c2', author: 'B', text: 'Other thread' }])
  const otherMore = app.querySelector<HTMLButtonElement>('.comment-more')!
  expect(document.activeElement).not.toBe(otherMore)
  expect(otherMore.getAttribute('aria-expanded')).toBe('false')
  expect(app.querySelector<HTMLElement>('.comment-menu')!.hidden).toBe(true)
})

it.each(['pointerdown', 'focus'])('closes when %s moves to a sibling Like action', method => {
  const { more, menu } = mount()
  more.click()
  const like = app.querySelector<HTMLButtonElement>('.comment-like')!
  if (method === 'focus') like.focus()
  else like.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(menu.hidden).toBe(true)
})
