import { hostError } from '../../../../packages/web-contracts/src/errors.ts'
import type { DesktopApi } from '../../../docs/src/shared/ipc'
import type { SessionFileHost } from '../../../../packages/browser-host/src/files.ts'
import { createSaveGenerationGuard, type SaveTicket } from '../../../../packages/browser-host/src/save-generation.ts'
import { messages } from './messages.ts'

/** A narrow compatibility bridge for the existing renderer. Opaque paths are
 * aliases only; they never become filesystem paths or server authorization. */
export function createDocsBridge(host: SessionFileHost, fileId: string, prefs: Awaited<ReturnType<SessionFileHost['getPreferences']>>, onChange: () => void) {
  const locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale], state = host.getState(fileId)
  const alias = `/files/${fileId}/${state.name}`, guard = createSaveGenerationGuard(), urls = new Set<string>()
  let disposed = false, downloading = false
  let saveFence:(()=>boolean)|null=null
  async function guardedSave(check:()=>boolean,action:()=>Promise<boolean>){
    if(saveFence||!check())return false
    saveFence=check
    try{return await action()}finally{saveFence=null}
  }
  let committed: import('../../../../packages/web-contracts/src/api').RevisionRef | null = null
  let consumed = false, ticket: SaveTicket | null = null
  let nativeSaveOutcome: 'none' | 'pending' | 'accepted' | 'incomplete' = 'none'
  let nativeSaveReasons: readonly string[] = []
  const unavailable = async () => { throw new Error(text.unavailable) }
  const noEvent = () => () => {}
  const lifecycle = {
    documentOpened() { guard.reset(); ticket = null; nativeSaveOutcome = 'none'; nativeSaveReasons = []; onChange() },
    edited() { guard.markEdited(); onChange() },
    async beforeSave() {
      // The native queue may have waited after the download preflight. Do not
      // turn this action into implicit confirmation of an intervening save.
      if (downloading && (disposed || host.getState(fileId).status !== 'idle' || guard.getState().status === 'unknown')) throw hostError('UNAVAILABLE','download not ready')
      nativeSaveOutcome = 'pending'; nativeSaveReasons = []
      if (guard.getState().status === 'unknown') {
        await host.reconcile(fileId,saveFence??(()=>true))
        if (ticket) guard.settleSave(ticket,'committed')
        ticket = null
      }
      ticket = guard.beginSave()
      onChange()
    },
    afterSave(accepted: boolean, incompleteReasons: readonly string[] = []) {
      nativeSaveOutcome = accepted ? 'accepted' : 'incomplete'
      nativeSaveReasons = [...incompleteReasons]
      if (ticket && guard.getState().status !== 'unknown') { guard.settleSave(ticket,'failed'); ticket = null }
      if (accepted && host.getState(fileId).status === 'idle') guard.reset()
      // Native metadata edits do not emit a ProseMirror update. An incomplete
      // native save must not make the Web status claim that those edits landed.
      if (!accepted && host.getState(fileId).status === 'idle' && !guard.getState().dirty) guard.markEdited()
      onChange()
    },
  }
  const api = {
    getLanguage: async () => locale,
    getSystemLocale: async () => navigator.language,
    getTheme: async () => prefs.theme,
    getDocumentTheme: async () => 'follow' as const,
    getAuthorName: async () => prefs.authorName ?? '',
    getAutoSaveDefault: async () => ({ on: prefs.autoSave ?? true,updatedAt: 1 }),
    getAiPanelPrefs: async () => ({ side: 'left' as const,fontSize: 'default' as const,customFontSize: 14,spellcheck: true,openInNewDocs: false,showAiSidebar: false,showAiAskTrigger: false }),
    onLanguageChanged: noEvent,onThemeChanged: noEvent,onDocumentThemeChanged: noEvent,onAuthorNameChanged: noEvent,onAutoSaveDefaultChanged: noEvent,onAiPanelPrefsChanged: noEvent,
    onOpenDocx: noEvent,onRenamedDocx: noEvent,onMenuCommand: noEvent,onTeardown: noEvent,onViewImage: noEvent,onContextMenuRequest: noEvent,onCloseCheck: noEvent,onCloseSaveRequest: noEvent,
    getRecentFiles: async () => [],
    fontMetrics: async () => null,
    fontAliases: async () => ({}),
    consumeNewBlankDoc: async () => false,
    consumeAiDocContent: async () => null,
    consumeHeadlessExport: async () => null,
    docPasswordIntentRevision: async () => 0,
    // The Web host cannot create password intents; replacement cleanup has none.
    discardDocPasswordIntents: async () => ({ ok: true }),
    armContextMenu() {},
    claimContextMenu() {},
    async consumePendingOpenDocx() {
      if (consumed) return null
      consumed = true
      const ref = host.getState(fileId).revision, bytes = await host.readBytes(fileId,ref.revision)
      const dataUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer],{ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
      urls.add(dataUrl)
      return { path: alias,name: state.name,dataUrl,hash: ref.sha256 }
    },
    async saveDocx(path: string, data: ArrayBuffer) {
      if (path !== alias || (saveFence && !saveFence())) return { ok: false,error: text.saveFailed }
      try {
        committed = await host.save(fileId,new Uint8Array(data),saveFence??(()=>true))
        if (ticket) guard.settleSave(ticket,'committed')
        ticket = null; onChange()
        return { ok: true }
      } catch {
        const unknown = host.getState(fileId).status === 'unknown'
        if (ticket) guard.settleSave(ticket,unknown ? 'unknown' : 'failed')
        if (!unknown) ticket = null
        onChange()
        return { ok: false,error: unknown ? text.unknown : host.getState(fileId).status === 'conflict' ? text.conflict : text.saveFailed }
      }
    },
    confirmDocumentReplace: async () => window.confirm(text.conflict),
    openDocx: unavailable,openDocxPath: unavailable,openDocxDecrypt: unavailable,
    saveDocxAs: unavailable,saveDocxNew: unavailable,saveDocxTo: unavailable,
    setDocPassword: unavailable,writeRecoveryCopy: unavailable,
    pickImage: unavailable,fetchImage: unavailable,saveImageAs: unavailable,
    openAiModelSettings: unavailable,openSkillsSettings: unavailable,
  } satisfies Partial<DesktopApi>
  async function prepareDownload(editor: {save(): Promise<boolean>; isDirty(): boolean}) {
    const before = host.getState(fileId)
    if (disposed || downloading || before.status !== 'idle' || !before.lease || guard.getState().status !== 'idle' || nativeSaveOutcome === 'pending') throw hostError('UNAVAILABLE','download not ready')
    downloading = true
    try {
      // Only the native save flushes pending table input and awaits its complete
      // serialization/acknowledgement. isDirty alone cannot replace that flush.
      // Never enter reconciliation implicitly from an unknown host state.
      if (!await editor.save()) throw hostError('UNAVAILABLE','download save')
      if (disposed) throw hostError('UNAVAILABLE','disposed')
      const current = host.getState(fileId), local = guard.getState(), receipt = committed
      if (editor.isDirty() || local.dirty || local.status !== 'idle' || nativeSaveOutcome !== 'accepted' || current.status !== 'idle' || !current.lease || !receipt ||
          receipt.fileId !== current.revision.fileId || receipt.revision !== current.revision.revision || receipt.sha256 !== current.revision.sha256 || receipt.size !== current.revision.size) throw hostError('CONFLICT','download not confirmed')
      return {...receipt}
    } finally { downloading = false }
  }
  return { api,lifecycle,guardedSave,prepareDownload,getReceipt:()=>committed,getState: () => ({...guard.getState(), nativeSaveOutcome, nativeSaveReasons}),dispose() { disposed = true; for (const url of urls) URL.revokeObjectURL(url); urls.clear() } }
}
