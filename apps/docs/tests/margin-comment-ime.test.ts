import { afterEach, expect, it } from 'vitest'
import { isMarginCommentImeConfirm, syncMarginAnnotations } from '../src/renderer/editor/margin-annotations'

let app: HTMLDivElement
function mount() {
  app = document.createElement('div'); app.className = 'app'; app.setAttribute('data-comment-cards', '')
  const wrap = document.createElement('div'), pm = document.createElement('div'), anchor = document.createElement('span')
  wrap.className = 'page-wrap'; pm.className = 'ProseMirror'; anchor.className = 'doc-comment'; anchor.dataset.commentIds = 'c1'
  anchor.getClientRects = () => [{ top: 100, bottom: 116, left: 10, right: 50, height: 16 }] as unknown as DOMRectList
  pm.append(anchor); wrap.append(pm); app.append(wrap); document.body.append(app)
  const calls: string[] = []
  syncMarginAnnotations(wrap, pm, [{ id: 'c1', author: 'A', text: 'Original' }], 1, [], undefined, {
    onCommentReply: (id, text) => calls.push(`reply:${id}:${text}`),
    onCommentEdit: (id, text) => calls.push(`edit:${id}:${text}`),
  })
  return { wrap, calls }
}
afterEach(() => app?.remove())
for (const kind of ['reply', 'edit-ctrl', 'edit-meta'] as const) {
  it.each(['native', 'legacy', 'active', 'just-ended'] as const)(`margin ${kind} keeps IME draft (%s), then submits normally`, async signal => {
    const { wrap, calls } = mount()
    if (kind !== 'reply') {
      wrap.querySelector<HTMLButtonElement>('.comment-more')!.click()
      wrap.querySelector<HTMLButtonElement>('.comment-card-edit')!.click()
    }
    const input = wrap.querySelector<HTMLInputElement | HTMLTextAreaElement>(kind === 'reply' ? '.comment-reply-input' : '.comment-edit-input')!
    input.value = 'Draft'; input.focus()
    const compose = (type: string) => input.dispatchEvent(new CompositionEvent(type, { bubbles: true }))
    const enter = (init: KeyboardEventInit = {}) => {
      const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true,
        ctrlKey: kind === 'edit-ctrl', metaKey: kind === 'edit-meta', ...init }); input.dispatchEvent(e); return e
    }
    if (signal === 'active' || signal === 'just-ended') compose('compositionstart')
    if (signal === 'just-ended') compose('compositionend')
    const event = enter(signal === 'native' ? { isComposing: true } : signal === 'legacy' ? { keyCode: 229 } : {})
    expect(calls).toEqual([]); expect(input.isConnected).toBe(true); expect(input.value).toBe('Draft'); expect(event.defaultPrevented).toBe(false)
    if (signal === 'active') compose('compositionend')
    await new Promise(resolve => setTimeout(resolve, 5))
    enter()
    expect(calls).toEqual([`${kind === 'reply' ? 'reply' : 'edit'}:c1:Draft`])
    if (kind === 'reply') expect(input.value).toBe('')
    else { expect(input.isConnected).toBe(false); expect(wrap.querySelector('.comment-text')?.textContent).toBe('Original') }
  })
}

for (const kind of ['reply', 'edit'] as const) {
  it.each(['native', 'legacy', 'active', 'just-ended'] as const)(`margin ${kind} preserves IME Escape (%s), then cancels normally`, async signal => {
    const { wrap, calls } = mount()
    if (kind === 'edit') {
      wrap.querySelector<HTMLButtonElement>('.comment-more')!.click()
      wrap.querySelector<HTMLButtonElement>('.comment-card-edit')!.click()
    }
    const input = wrap.querySelector<HTMLInputElement | HTMLTextAreaElement>(kind === 'reply' ? '.comment-reply-input' : '.comment-edit-input')!
    input.value = 'Draft'; input.focus()
    let captureIme = false
    app.addEventListener('keydown', e => { captureIme = isMarginCommentImeConfirm(e) }, true)
    let escaped = 0
    const parent = () => escaped++
    app.addEventListener('keydown', parent)
    if (signal === 'active' || signal === 'just-ended') input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    if (signal === 'just-ended') input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    const escape = (init: KeyboardEventInit = {}) => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
      input.dispatchEvent(e)
      return e
    }
    const event = escape(signal === 'native' ? { isComposing: true } : signal === 'legacy' ? { keyCode: 229 } : {})
    expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Draft')
    expect(calls).toEqual([])
    expect(escaped).toBe(0)
    expect(captureIme).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    if (signal === 'active') input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 5))
    escape()
    expect(captureIme).toBe(false)
    if (kind === 'edit') expect(input.isConnected).toBe(false)
    else expect(document.activeElement).not.toBe(input)
    expect(calls).toEqual([])
  })
}


it('does not carry composition from a removed margin editor to its replacement', () => {
  const { wrap, calls } = mount()
  const edit = () => {
    wrap.querySelector<HTMLButtonElement>('.comment-more')!.click()
    wrap.querySelector<HTMLButtonElement>('.comment-card-edit')!.click()
    return wrap.querySelector<HTMLTextAreaElement>('.comment-edit-input')!
  }
  const previous = edit()
  previous.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  wrap.querySelector<HTMLButtonElement>('.comment-compose-actions button')!.click()
  const current = edit()
  let captureIme = true
  app.addEventListener('keydown', e => { captureIme = isMarginCommentImeConfirm(e) }, true)
  current.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(captureIme).toBe(false)
  expect(current.isConnected).toBe(false)
  expect(calls).toEqual([])
})
