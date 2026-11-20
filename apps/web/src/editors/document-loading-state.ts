export type DocumentLoadingState = 'reading' | 'rendering' | 'ready' | 'error'

/** Retain state for a parent whose iframe load event fires after document readiness. */
export function reportDocumentLoading(state: DocumentLoadingState) {
  document.documentElement.dataset.documentLoading = state
  if (window.parent !== window) window.parent.postMessage({type:'dyoffice-document-loading',state},location.origin)
}
