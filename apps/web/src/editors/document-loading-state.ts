import {CitedRevisionChanged} from '../../../../packages/browser-host/src/session-files'

export type DocumentLoadingState = 'reading' | 'rendering' | 'ready' | 'error' | 'citation-expired'

declare global { interface Window { dyofficeDisplayedRevision?:()=>string|undefined } }

export function registerDisplayedRevision(read:()=>string|undefined){
  window.dyofficeDisplayedRevision=()=>document.documentElement.dataset.documentLoading==='ready'?read():undefined
}

export function reportDocumentOpenError(error:unknown) {
  reportDocumentLoading(error instanceof CitedRevisionChanged ? 'citation-expired' : 'error')
}

/** Retain state for a parent whose iframe load event fires after document readiness. */
export function reportDocumentLoading(state: DocumentLoadingState) {
  document.documentElement.dataset.documentLoading = state
  if (window.parent !== window) window.parent.postMessage({type:'dyoffice-document-loading',state},location.origin)
}
