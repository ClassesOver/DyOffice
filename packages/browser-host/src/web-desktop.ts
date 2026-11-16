import { hostError } from '../../web-contracts/src/errors.ts'

export interface WebDesktopOptions {
  fileId: string
  fileName: string
  readBytes: (fileId: string) => Promise<Uint8Array>
  saveBytes: (fileId: string, bytes: Uint8Array) => Promise<{ revision: string }>
  print?: () => void
  readClipboardText?: () => Promise<string>
  writeClipboardText?: (text: string) => Promise<void>
  /** Explicit fallback chains. A missing family is not reported as installed. */
  fonts?: Record<string, readonly string[]>
  language?: 'zh' | 'en'
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const hash = await crypto.subtle.digest('SHA-256', copy)
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function dataUrl(bytes: Uint8Array): string {
  let binary = ''
  for (const value of bytes) binary += String.fromCharCode(value)
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${btoa(binary)}`
}

/**
 * Browser stand-in for the Docs desktop bridge. File bytes go through the
 * supplied host. Every method that is not implemented here throws UNSUPPORTED
 * instead of resolving a successful result.
 */
export function createWebDesktop(options: WebDesktopOptions) {
  const noop = () => () => {}
  const impl = {
    async getLanguage() { return options.language ?? 'zh' as const },
    async getSystemLocale() { return 'zh-CN' },
    async getTheme() { return 'system' as const },
    async getDocumentTheme() { return 'follow' as const },
    async getAutoSaveDefault() { return 'on' as const },
    async getAuthorName() { return '' },
    async getAiPanelPrefs() { return { textScale: 1, spellcheck: false } },
    async setAiPanelPrefs(patch: { textScale?: number; spellcheck?: boolean }) {
      return { textScale: patch.textScale ?? 1, spellcheck: patch.spellcheck ?? false }
    },
    onLanguageChanged: noop(),
    onThemeChanged: noop(),
    onDocumentThemeChanged: noop(),
    onAutoSaveDefaultChanged: noop(),
    onAuthorNameChanged: noop(),
    onAiPanelPrefsChanged: noop(),
    onChromePressed: noop(),
    onOpenDocx: noop(),
    onRenamedDocx: noop(),
    onTeardown: noop(),
    onCloseCheck: noop(),
    onCloseSaveRequest: noop(),
    onMenuCommand: noop(),
    async openDocx() {
      const data = await options.readBytes(options.fileId)
      return { path: options.fileId, name: options.fileName, dataUrl: dataUrl(data), hash: await digest(data) }
    },
    async openDocxPath(path: string) {
      const data = await options.readBytes(path)
      return { path, name: options.fileName, dataUrl: dataUrl(data), hash: await digest(data) }
    },
    async consumePendingOpenDocx() { return null },
    async consumeNewBlankDoc() { return false },
    async getRecentFiles() { return [options.fileId] },
    async saveDocx(path: string, data: ArrayBuffer) {
      const bytes = new Uint8Array(data)
      const saved = await options.saveBytes(path || options.fileId, bytes)
      return { ok: true, revision: saved.revision }
    },
    async saveDocxAs(_name: string, _data: ArrayBuffer, _sourcePath?: string) { throw hostError('UNSUPPORTED', 'saveDocxAs') },
    async saveDocxNew(_name: string, _data: ArrayBuffer) { throw hostError('UNSUPPORTED', 'saveDocxNew') },
    async saveDocxTo(_path: string, _data: ArrayBuffer, _overwrite?: boolean) { throw hostError('UNSUPPORTED', 'saveDocxTo') },
    async fontAliases(names: readonly string[]) {
      const fonts = options.fonts ?? {}
      return Object.fromEntries(names.map((name) => [name, fonts[name] ? [...fonts[name]] : []]))
    },
    async fontMetrics() {
      return null
    },
    async print() {
      if (!options.print) throw hostError('UNSUPPORTED', 'print')
      options.print()
      return { ok: true }
    },
    async writeClipboardText(text: string) {
      if (!options.writeClipboardText) throw hostError('UNSUPPORTED', 'writeClipboardText')
      await options.writeClipboardText(text)
    },
    async readClipboardText() {
      if (!options.readClipboardText) throw hostError('UNSUPPORTED', 'readClipboardText')
      return options.readClipboardText()
    },
    async copyImageToClipboard() { throw hostError('UNSUPPORTED', 'copyImageToClipboard') },
  }
  return new Proxy(impl, {
    get(target, prop) {
      if (prop === 'then') return undefined
      if (typeof prop !== 'string') return undefined
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop as keyof typeof target]
      return () => { throw hostError('UNSUPPORTED', prop) }
    },
  })
}
