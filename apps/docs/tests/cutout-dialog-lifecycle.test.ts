import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CutoutDialog } from '../src/renderer/components/PictureDialogs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
let images: { onload?: () => void }[]
const apply = vi.fn()
function Harness() {
  const [open, setOpen] = useState(true)
  return open ? createElement(CutoutDialog, {
    dataUrl: 'data:image/png;base64,original', onApply: apply, onCancel: () => setOpen(false),
  }) : null
}
beforeEach(() => {
  vi.useFakeTimers(); apply.mockReset(); images = []
  vi.stubGlobal('Image', class {
    onload?: () => void
    naturalWidth = 4; naturalHeight = 4
    constructor() { images.push(this) }
  })
  vi.stubGlobal('ImageData', class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(), putImageData: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(4 * 4 * 4).fill(255) }),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cutout')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root.render(createElement(Harness)))
  act(() => images[0]!.onload!())
})
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function start() {
  const button = host.querySelector<HTMLButtonElement>('button.primary')!
  expect(button.disabled).toBe(false)
  act(() => button.click())
  expect(apply).not.toHaveBeenCalled()
}
it('does not apply deferred background removal after Escape closes the dialog', () => {
  start()
  act(() => host.querySelector('.modal-backdrop')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('.modal')).toBeNull()
  act(() => vi.advanceTimersByTime(30))
  expect(apply).not.toHaveBeenCalled()
})
it('does not apply after the containing document unmounts', () => {
  start()
  act(() => root.render(null))
  act(() => vi.advanceTimersByTime(30))
  expect(apply).not.toHaveBeenCalled()
})
it('still applies exactly once when the dialog remains open', () => {
  start()
  act(() => vi.advanceTimersByTime(30))
  expect(apply).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,cutout')
})
