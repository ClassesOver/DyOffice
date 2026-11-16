import {useEffect, useRef, useState} from 'react'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {WorkspaceFile, WorkspaceFileList} from '../../../../packages/web-contracts/src/workspace'

export function WorkspaceTrash({request, onClose, onChanged}: {request: SettingsRequest; onClose(): void; onChanged(): void}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [busy, setBusy] = useState(true)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true), pending = useRef(false)
  async function load() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result: WorkspaceFile[] = []
      for (let offset = 0;;) {
        const page = await request<WorkspaceFileList>(`/api/v1/workspace/files?view=trash&limit=100&offset=${offset}`)
        if (!page || !Array.isArray(page.files) || !Number.isSafeInteger(page.total)) throw new Error('回收站响应无效。')
        result.push(...page.files); offset += page.files.length
        if (offset >= page.total) break
        if (!page.files.length) throw new Error('文件列表已变化，请重新加载。')
      }
      if (mounted.current) { setFiles(result); setUncertain(false) }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '回收站加载失败。') }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false } }, [])
  async function restore(id: string) {
    if (pending.current || uncertain) return
    pending.current = true; setBusy(true); setError('')
    try {
      await request(`/api/v1/files/${encodeURIComponent(id)}/restore`, 'POST')
      if (mounted.current) { setFiles(current => current.filter(file => file.id !== id)); onChanged() }
    } catch (failure) {
      if (!mounted.current) return
      const status = (failure as {status?: number})?.status
      const unknown = status === undefined || status >= 500
      setUncertain(unknown)
      setError(unknown ? '无法确认恢复结果，请重新加载回收站核对。' : (failure instanceof Error ? failure.message : '恢复失败。'))
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="set-overlay"><section className="set-dialog" role="dialog" aria-modal="true" aria-label="回收站">
    <header className="set-header"><h2 className="set-title">回收站</h2><button className="set-btn" disabled={busy} onClick={onClose}>关闭</button></header>
    <div className="set-body"><div className="set-pane workspace-trash">
      <p className="set-pane-desc">恢复文件会保留原始内容、收藏和文件夹归属。</p>
      {error && <p role="alert" className="set-web-error">{error}</p>}
      <button className="set-btn" disabled={busy} onClick={() => void load()}>重新加载</button>
      {busy && <p role="status">正在处理…</p>}
      {!busy && !files.length && <p>回收站为空。</p>}
      {files.map(file => <div className="set-field" key={file.id}><div className="set-field-text"><strong>{file.name}</strong><p className="set-pane-desc">{file.format.toUpperCase()} · {file.size.toLocaleString()} 字节</p></div><button className="set-btn" disabled={busy || uncertain} onClick={() => void restore(file.id)}>恢复</button></div>)}
    </div></div>
  </section></div>
}

