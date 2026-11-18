import { createEditorBridge, type EditorBridgeStatus } from '../../../../packages/browser-host/src/editor-bridge.ts'
import type { SessionFileHost } from '../../../../packages/browser-host/src/files.ts'

/** Notifications describe the persisted head. They do not rebase the editor or
 * clear a draft; adopting another head remains an explicit HTTP operation. */
export function mountEditorRealtime(host: SessionFileHost, fileId: string, onChange: () => void,onChannels?:(channels:readonly {conversationId:string;sequence:number}[])=>void) {
  let remoteHead: string | null = null, status: EditorBridgeStatus = 'connecting'
  // Legacy/mocked hosts and non-browser mounts retain the HTTP-only path.
  if (typeof globalThis.WebSocket !== 'function' || typeof host.getEditorId !== 'function') return { notice: (_locale: 'en' | 'zh') => '', dispose() {} }
  const bridge = createEditorBridge({
    origin: location.origin, fileId, editorId: host.getEditorId(),
    onStatus(next) {
      status = next
      if (next === 'unauthorized') host.observeRealtime(fileId, null)
      onChange()
    },
    onEvent(event) {
      if(event.type==='assistant-channels'){onChannels?.(event.channels);return}
      if (event.type !== 'state' && event.type !== 'file-event') return
      const state = event.type === 'state' ? event : event.fileEvent
      remoteHead = state.headRevision
      host.observeRealtime(fileId, state)
      onChange()
    },
  })
  return {
    notice(locale: 'en' | 'zh') {
      if (remoteHead && remoteHead !== host.getState(fileId).revision.revision) return locale === 'en'
        ? 'A different saved version is available. Your draft is preserved.'
        : '检测到其他已保存版本，当前草稿已保留。'
      if (status === 'backoff') return locale === 'en'
        ? 'Restoring version updates. You can continue editing and saving.'
        : '正在恢复版本同步，文档仍可编辑和保存。'
      return ''
    },
    dispose() { bridge.dispose() },
  }
}
