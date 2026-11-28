export async function pickLocalFiles(accept: string, signal: AbortSignal, multiple = false, parent: HTMLElement = document.body): Promise<File[]> {
  signal.throwIfAborted()
  return new Promise(resolve => {
    const input = parent.ownerDocument.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.hidden = true
    const finish = (files: File[]) => {
      signal.removeEventListener('abort', cancel)
      input.remove()
      resolve(files)
    }
    const cancel = () => finish([])
    input.onchange = () => finish(Array.from(input.files ?? []))
    input.oncancel = cancel
    signal.addEventListener('abort', cancel, {once:true})
    parent.append(input)
    try { input.click() } catch { cancel() }
  })
}
