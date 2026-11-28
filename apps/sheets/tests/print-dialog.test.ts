// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { PrintDialog } from '../src/renderer/PrintDialog'
import type { PrintJob, PrintPreviewHost } from '../src/renderer/page-layout-actions'
import { resolveEffectivePageSetup } from '../src/renderer/print-settings'

it('waits for the selected print scope before allowing a page range to be sent', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const oldJob: PrintJob = { documents: [], fileName: 'active.pdf', pageCount: 2 }
  const newJob: PrintJob = { documents: [], fileName: 'selection.pdf', pageCount: 2 }
  let finishBuild!: (job: PrintJob) => void
  const pendingBuild = new Promise<PrintJob>((resolve) => { finishBuild = resolve })
  const host = {
    setup: resolveEffectivePageSetup({}, null, null),
    browserPrintDialog: true,
    marginsPreset: 'normal',
    hasSelection: true,
    chartSheet: false,
    sheetCount: 1,
    buildJob: vi.fn<PrintPreviewHost['buildJob']>().mockResolvedValueOnce(oldJob).mockReturnValueOnce(pendingBuild),
    listPrinters: vi.fn().mockResolvedValue([]),
    print: vi.fn().mockResolvedValue(''),
    exportPdf: vi.fn(),
    applySetting: vi.fn(),
    setMessage: vi.fn(),
  } satisfies PrintPreviewHost

  const select = (element: HTMLSelectElement, value: string) => {
    act(() => {
      element.value = value
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const type = (element: HTMLInputElement, value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  try {
    await act(async () => root.render(createElement(PrintDialog, {
      host,
      onClose: vi.fn(),
      onPageSetup: vi.fn(),
      revision: 0,
    })))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    const print = container.querySelector<HTMLButtonElement>('.primary-action')!
    expect(print.disabled).toBe(false)

    const scope = container.querySelector('option[value="selection"]')!.parentElement as HTMLSelectElement
    select(scope, 'selection')
    expect(print.disabled).toBe(true)
    print.click()
    expect(host.print).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(host.buildJob).toHaveBeenLastCalledWith('selection', expect.any(Object))
    expect(print.disabled).toBe(true)
    await act(async () => finishBuild(newJob))
    expect(print.disabled).toBe(false)

    select(container.querySelector('.print-pages-row select')!, 'range')
    const [from, to] = container.querySelectorAll<HTMLInputElement>('.print-pages-row input')
    type(to!, '2')
    type(from!, '1.5')
    expect(print.disabled).toBe(true)
    type(from!, '2')
    expect(print.disabled).toBe(false)
    await act(async () => print.click())
    expect(host.print).toHaveBeenCalledExactlyOnceWith(newJob, expect.objectContaining({
      pages: { from: 2, to: 2 },
    }))
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
