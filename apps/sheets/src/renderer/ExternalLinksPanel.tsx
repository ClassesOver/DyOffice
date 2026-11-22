import { useState, type ReactElement } from 'react'
import { useI18n } from './i18n/locale'
import type { ExternalLinkRow } from '../shared/desktop-api'

/// Excel's Edit Links as a panel: the workbook's `[n]` links with their
/// stored source path, the resolved local path, and the source's sheet names.
/// Reachability is unknown ("—") until the explicit Update: listing the links
/// must not probe the sources on disk (a dead network share can block the
/// open). Update re-reads reachable sources; broken links stay on their
/// cached values (Excel's own behaviour). Break turns the link's formulas
/// into their cached literals (Excel asks for confirmation because the file
/// cannot undo it); Change Source repoints the link at another file without
/// touching formulas or cached values. It is not offered for a web source
/// (`source: null`): there is no local file to repoint, and a `file:///`
/// target would be wrong for it.
export function ExternalLinksPanel({
  links,
  busy,
  sourceActions = true,
  workspaceActions = false,
  workspacePicker,
  canBreak = true,
  notice,
  onUpdate,
  onReveal,
  onBreak,
  onChangeSource,
  onSaveWorkspaceSource,
  onCancelWorkspaceSource,
  onClose,
}: {
  readonly links: readonly ExternalLinkRow[]
  readonly busy: boolean
  readonly sourceActions?: boolean
  readonly workspaceActions?: boolean
  readonly workspacePicker?: readonly {id:string;name:string}[] | undefined
  readonly canBreak?: boolean
  /** why the listing is empty when it is not simply "no links" */
  readonly notice?: 'unsaved' | 'unavailable' | null
  readonly onUpdate: () => void
  /** the row's link index, not its path: the main process resolves the source */
  readonly onReveal: (index: number) => void
  readonly onBreak: (index: number) => void
  readonly onChangeSource: (index: number) => void
  readonly onSaveWorkspaceSource?: (id: string) => void
  readonly onCancelWorkspaceSource?: () => void
  readonly onClose: () => void
}): ReactElement {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState<number | null>(null)
  const [sourceId, setSourceId] = useState('')
  const canUpdate = sourceActions || workspaceActions
  return (
    <section className="watch-window" role="dialog" aria-label={t('appLinksPanel')}>
      <header>
        <span className="watch-title">{t('appLinksPanel')}</span>
        {canUpdate && (
          <button className="watch-add" disabled={busy} onClick={onUpdate}>
            {t('appLinksUpdate')}
          </button>
        )}
        <button className="watch-close" data-tip={t('appClose')} onClick={onClose}>
          ✕
        </button>
      </header>
      {workspacePicker && (
        <div className="watch-link-picker">
          <label>
            {t('appLinksSource')}
            <select value={sourceId} onChange={(event) => setSourceId(event.currentTarget.value)}>
              <option value="">—</option>
              {workspacePicker.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
            </select>
          </label>
          <button className="watch-remove" disabled={busy || !workspacePicker.some(file=>file.id===sourceId)}
            onClick={()=>{onSaveWorkspaceSource?.(sourceId);setSourceId('')}}>{t('appThreadSave')}</button>
          <button className="watch-remove" onClick={()=>{onCancelWorkspaceSource?.();setSourceId('')}}>{t('appCancel')}</button>
        </div>
      )}
      {links.length === 0 ? (
        <p className="watch-empty">
          {notice === 'unavailable'
            ? t('appAttachmentReadFailed', {name:t('appLinksPanel')})
            : t(notice === 'unsaved' ? 'appLinksUnsaved' : 'appLinksNone')}
        </p>
      ) : (
        <table className="watch-table">
          <thead>
            <tr>
              <th>{t('appLinksSource')}</th>
              {canUpdate && <th>{t('appLinksStatus')}</th>}
              <th>{t('appLinksSheets')}</th>
              {(canUpdate || canBreak) && <th />}
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr key={link.index}>
                <td className="watch-formula" title={link.displayName?link.rawTarget:undefined}>
                  {link.displayName ?? link.rawTarget}
                  {link.source !== null && link.source !== link.rawTarget ? (
                    <span className="watch-gone"> → {link.source}</span>
                  ) : null}
                </td>
                {canUpdate && (
                  <td>
                    {link.reachable === undefined
                      ? '—'
                      : link.reachable
                        ? t('appLinksReachable')
                        : t('appLinksBroken')}
                  </td>
                )}
                <td>{link.sheetNames.join(', ')}</td>
                {(canUpdate || canBreak) && (
                  <td>
                    {sourceActions && link.reachable === true && link.source !== null ? (
                      <button
                        className="watch-remove"
                        data-tip={t('appLinksLocate')}
                        onClick={() => onReveal(link.index)}
                      >
                        📂
                      </button>
                    ) : null}
                    {workspaceActions || (sourceActions && link.source !== null) ? (
                      <button
                        className="watch-remove"
                        data-tip={t('appLinksChangeSource')}
                        aria-label={t('appLinksChangeSource')}
                        disabled={busy}
                        onClick={() => onChangeSource(link.index)}
                      >
                        🔗
                      </button>
                    ) : null}
                    {canBreak && (confirming === link.index ? (
                      <button
                        className="watch-remove"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(null)
                          onBreak(link.index)
                        }}
                      >
                        {t('appLinksBreakConfirm')}
                      </button>
                    ) : (
                      <button
                        className="watch-remove"
                        data-tip={t('appLinksBreak')}
                        aria-label={t('appLinksBreak')}
                        disabled={busy}
                        onClick={() => setConfirming(link.index)}
                      >
                        ✂
                      </button>
                    ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
