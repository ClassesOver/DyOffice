import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CropDialog } from '../src/renderer/components/PictureDialogs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
const apply = vi.fn(), cancel = vi.fn()
beforeEach(() => {
  apply.mockReset(); cancel.mockReset()
  const images: { naturalWidth: number; naturalHeight: number; onload?: () => void; src?: string }[] = []
  vi.stubGlobal('Image', class {
    naturalWidth = 120; naturalHeight = 80
    constructor() { images.push(this) }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cropped')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root.render(createElement(CropDialog, { dataUrl: 'data:image/png;base64,original', onApply: apply, onCancel: cancel })))
  act(() => images[0]!.onload!())
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function enter(target: EventTarget) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}
it('leaves Enter on cancel to the button default action without applying the crop', () => {
  const button = host.querySelector<HTMLButtonElement>('.modal-actions button')!
  button.focus()
  expect(enter(button).defaultPrevented).toBe(false)
  expect(apply).not.toHaveBeenCalled()
  // jsdom does not synthesize a click from a keyboard default action.
  act(() => button.click())
  expect(cancel).toHaveBeenCalledOnce()
  expect(apply).not.toHaveBeenCalled()
})
it('applies once through the apply button without intercepting its Enter event', () => {
  const button = host.querySelector<HTMLButtonElement>('.modal-actions button.primary')!
  expect(button.disabled).toBe(false); button.focus()
  expect(enter(button).defaultPrevented).toBe(false)
  expect(apply).not.toHaveBeenCalled()
  act(() => button.click())
  expect(apply).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,cropped')
  expect(cancel).not.toHaveBeenCalled()
})
it('does not apply from a window Enter while focus is outside the dialog', () => {
  host.querySelector<HTMLButtonElement>('button')!.blur()
  enter(window)
  expect(apply).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
})
