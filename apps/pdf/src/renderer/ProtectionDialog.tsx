import { useState } from 'react'
import type { TFunc } from './i18n/locale'
import type { PdfEncryptionInput, PdfPermissions } from '../shared/ipc'

/**
 * Review → Protection: set, change or lift the password the document is saved
 * under, and the limits a reader has once it is open. The desktop applies the
 * configuration on its next save. A browser host can export a protected copy.
 */
export function ProtectionDialog({
  t,
  hasPassword,
  permissions,
  onApply,
  protectedCopy,
  onRemove,
  onClose,
}: {
  t: TFunc
  /** whether the document on disk is currently password-protected */
  hasPassword: boolean
  permissions: PdfPermissions
  onApply: (result: PdfEncryptionInput) => void
  protectedCopy?: {
    title: string
    description: string
    action: string
    save: (result: PdfEncryptionInput) => Promise<string | null>
  }
  onRemove: () => void
  onClose: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [owner, setOwner] = useState('')
  const [perms, setPerms] = useState<PdfPermissions>(permissions)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const title = protectedCopy?.title ?? t('protectTitle')

  const apply = async (): Promise<void> => {
    if (busy) return
    if (password.length === 0 || password !== confirm) {
      setError(t('protectMismatch'))
      return
    }
    const settings = {
      userPassword: password,
      ownerPassword: owner.length > 0 ? owner : password,
      permissions: perms,
    }
    if (!protectedCopy) {
      onApply(settings)
      return
    }
    setBusy(true)
    setError(null)
    try {
      setError(await protectedCopy.save(settings))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (key: keyof PdfPermissions): void => {
    setPerms((current) => ({ ...current, [key]: !current[key] }))
  }

  const checkbox = (key: keyof PdfPermissions, label: string): React.JSX.Element => (
    <label className="pdf-perm-row">
      <input type="checkbox" disabled={busy} checked={perms[key]} onChange={() => toggle(key)} />
      <span>{label}</span>
    </label>
  )

  return (
    <div className="pdf-modal-mask" onClick={busy ? undefined : onClose}>
      <div
        className="pdf-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pdf-modal-title">{title}</div>
        <div className="pdf-modal-hint">
          {protectedCopy?.description ?? (hasPassword ? t('protectChangeHint') : t('protectSetHint'))}
        </div>

        <div className="pdf-field">
          <label className="pdf-perm-row">
            <span>{t('protectPasswordLabel')}</span>
            <input
              type="password"
              disabled={busy}
              className="pdf-modal-input"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError(null)
              }}
              autoFocus
            />
          </label>
          <label className="pdf-perm-row">
            <span>{t('protectConfirmLabel')}</span>
            <input
              type="password"
              disabled={busy}
              className="pdf-modal-input"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
                setError(null)
              }}
            />
          </label>
          <label className="pdf-perm-row">
            <span>{t('protectOwnerLabel')}</span>
            <input
              type="password"
              disabled={busy}
              className="pdf-modal-input"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </label>
        </div>

        <div className="pdf-field">
          <div className="pdf-modal-hint">{t('protectPermsLabel')}</div>
          {checkbox('printing', t('permPrint'))}
          {checkbox('modifying', t('permModify'))}
          {checkbox('annotating', t('permAnnotate'))}
          {checkbox('copying', t('permCopy'))}
        </div>

        {error && (
          <div className="pdf-field">
            <div className="pdf-cert-error" role="alert">
              {error}
            </div>
          </div>
        )}

        <div className="pdf-modal-actions">
          {hasPassword && !protectedCopy && (
            <button
              className="pdf-modal-btn"
              onClick={() => {
                onRemove()
              }}
            >
              {t('protectRemove')}
            </button>
          )}
          <button className="pdf-modal-btn" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="pdf-modal-btn primary" disabled={busy} onClick={() => void apply()}>
            {busy ? t('saving') : protectedCopy?.action ?? t('protectApply')}
          </button>
        </div>
      </div>
    </div>
  )
}
