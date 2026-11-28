import type {PublicSettings} from '../../../../packages/web-contracts/src/api'
import type {DocumentTheme} from '../../../../packages/web-contracts/src/preferences'

type Themes = Pick<PublicSettings,'theme'|'documentTheme'>

export function applyBrowserEditorTheme(root: HTMLElement, prefs: Themes): void {
  if (prefs.theme === 'system') delete root.dataset.theme
  else root.dataset.theme = prefs.theme
  if (!prefs.documentTheme || prefs.documentTheme === 'follow') delete root.dataset.docTheme
  else root.dataset.docTheme = prefs.documentTheme
}

export function browserEditorTheme(prefs: Themes) {
  const root = typeof document === 'undefined' ? undefined : document.documentElement
  const readTheme = (): Themes['theme'] => {
    if (!root) return prefs.theme
    const value = root.dataset.theme
    return value === 'light' || value === 'dark' ? value : 'system'
  }
  const readDocumentTheme = (): DocumentTheme => {
    if (!root) return prefs.documentTheme ?? 'follow'
    const value = root.dataset.docTheme
    return value === 'light' || value === 'dark' ? value : 'follow'
  }
  function observe<T>(attribute: string, read: () => T, listener: (value: T) => void): () => void {
    if (!root || typeof MutationObserver === 'undefined') return () => {}
    let mode = read()
    const observer = new MutationObserver(() => {
      const next = read()
      if (mode === next) return
      mode = next
      listener(next)
    })
    observer.observe(root, {attributeFilter:[attribute]})
    return () => observer.disconnect()
  }
  return {
    getTheme: async () => readTheme(),
    getDocumentTheme: async () => readDocumentTheme(),
    onThemeChanged: (listener: (theme: Themes['theme']) => void) => observe('data-theme',readTheme,listener),
    onDocumentThemeChanged: (listener: (theme: DocumentTheme) => void) => observe('data-doc-theme',readDocumentTheme,listener),
  }
}
