export type WorkspaceOpenFrame = HTMLIFrameElement & {
  dyofficeOpenWorkspaceFile?: () => boolean
  dyofficeTakeOfficeImportUnlock?: (revision: string) => string | undefined
}

export function takeOfficeImportUnlock(revision: string, stage: Window = window): string | undefined {
  try {
    const frame = stage.frameElement as WorkspaceOpenFrame | null
    if (frame?.isConnected && frame.ownerDocument.defaultView === stage.parent) return frame.dyofficeTakeOfficeImportUnlock?.(revision)
  } catch {
    return undefined
  }
}

export function workspaceOpenAction(stage: Window = window): (() => boolean) | undefined {
  try {
    const frame = stage.frameElement as WorkspaceOpenFrame | null
    if (!frame?.isConnected || frame.ownerDocument.defaultView !== stage.parent || !frame.dyofficeOpenWorkspaceFile) return
    return () => frame.dyofficeOpenWorkspaceFile?.() ?? false
  } catch {
    return
  }
}

export const browserDocumentEvents = {
  print: 'dyoffice-print-document',
  save: 'dyoffice-save-document',
  'save-as': 'dyoffice-save-document-copy',
  'zoom-in': 'dyoffice-zoom-in',
  'zoom-out': 'dyoffice-zoom-out',
  'zoom-reset': 'dyoffice-zoom-reset',
} as const

export type BrowserDocumentCommand = keyof typeof browserDocumentEvents

export function dispatchBrowserDocumentCommand(editor: Window | null | undefined, command: BrowserDocumentCommand): boolean {
  try {
    return !!editor && !editor.dispatchEvent(new Event(browserDocumentEvents[command], {cancelable:true}))
  } catch {
    return false
  }
}

export function subscribeBrowserDocumentCommands(
  handlers: Partial<Record<BrowserDocumentCommand, () => void>>,
  canRun: () => boolean,
): () => void {
  const subscriptions = (Object.keys(browserDocumentEvents) as BrowserDocumentCommand[]).flatMap(command => {
    const run = handlers[command]
    if (!run) return []
    const eventType = browserDocumentEvents[command]
    const receive = (event: Event) => {
      if (document.documentElement.dataset.documentLoading !== 'ready' || !canRun()) return
      event.preventDefault()
      run()
    }
    window.addEventListener(eventType, receive)
    return [() => window.removeEventListener(eventType, receive)]
  })
  return () => subscriptions.forEach(unsubscribe => unsubscribe())
}
