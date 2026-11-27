/** Print the already paginated workbook in a separate, script-free document. */
export async function printSheetsInBrowser(html: string, fileName: string): Promise<void> {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  Object.assign(frame.style, {
    position: 'fixed', left: '-10000px', top: '0', width: '800px', height: '600px', border: '0',
  })
  const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data: blob:; base-uri 'none'; form-action 'none'"
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => resolve(), { once: true })
    frame.addEventListener('error', () => reject(new Error('Print document failed to load.')), { once: true })
  })
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">` +
    html.replace(/^\s*<!doctype html>/i, '')
  try {
    document.body.append(frame)
    await loaded
    const printWindow = frame.contentWindow
    if (!printWindow) throw new Error('Print document has no window.')
    printWindow.document.title = fileName.replace(/\.pdf$/i, '')
    await printWindow.document.fonts.ready

    let started = false
    printWindow.addEventListener('beforeprint', () => { started = true }, { once: true })
    const finished = new Promise<void>((resolve) => {
      printWindow.addEventListener('afterprint', () => resolve(), { once: true })
    })
    printWindow.focus()
    printWindow.print()
    // A browser can return while its print dialog is still open.
    if (started) await finished
  } finally {
    frame.remove()
  }
}
