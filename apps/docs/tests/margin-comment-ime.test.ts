import { afterEach, expect, it } from 'vitest'
import { syncMarginAnnotations } from '../src/renderer/editor/margin-annotations'

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
