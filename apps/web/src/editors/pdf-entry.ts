import {mountPdfEditor} from './pdf-viewer.ts'
export {mountPdfEditor,PDF_VIEWER_CSP} from './pdf-viewer.ts'

function status(message: string) {
  const node = document.querySelector('#status')
  if (node) node.textContent = message
}

async function boot() {
  const view = window as Window & { dyofficeEditorCanClose?: () => boolean, dyofficeEditorDiscard?: () => void }
  view.dyofficeEditorCanClose = () => true
  view.dyofficeEditorDiscard = () => {}
  const file = new URLSearchParams(location.search).get('file') ?? ''
  if (!/^[a-zA-Z0-9-]+$/.test(file)) {
    status('没有可打开的 PDF。')
    return
  }
  const token = sessionStorage.getItem('dyoffice-user-token') ?? ''
  const response = await fetch(`/api/files/${file}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) {
    status('无法打开此 PDF。')
    return
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const host = document.querySelector('#app')
  if (!(host instanceof HTMLElement)) return
  try {
    await mountPdfEditor(host, bytes)
    status('已按原始字节打开。批注、改字、调页和脱敏仍不可用。')
  } catch (error) {
    host.replaceChildren()
    status(error instanceof Error && error.name === 'PasswordException' ? '此 PDF 需要密码，页面不会打开。' : '无法打开此 PDF。')
  }
}

if (typeof document !== 'undefined' && document.body?.dataset.page === 'pdf') void boot()
