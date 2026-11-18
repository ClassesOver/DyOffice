import { Dropdown } from '@genoffice/ui'
import { useI18n } from '../i18n/locale'
import { useModalKeys } from './modal-keys'

type PageNumberFormat = { fmt: string; start: string }

export function PageNumberFormatDialog({ value, sectionCount, activeSection, onChange, onApply, onClose }: {
  value: PageNumberFormat
  sectionCount: number
  activeSection: number
  onChange: (value: PageNumberFormat) => void
  onApply: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(onClose)
  return (
    <div
      {...modalKeys}
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <h2>{t('appPageNumFormatTitle')}</h2>
        <label className="pgnum-row">
          {t('appNumberFormat')}
          <Dropdown
            value={value.fmt}
            ariaLabel={t('appNumberFormat')}
            options={[
              { value: 'decimal', label: '1, 2, 3, …' },
              { value: 'numberInDash', label: '- 1 -, - 2 -, - 3 -, …' },
              { value: 'lowerLetter', label: 'a, b, c, …' },
              { value: 'upperLetter', label: 'A, B, C, …' },
              { value: 'lowerRoman', label: 'i, ii, iii, …' },
              { value: 'upperRoman', label: 'I, II, III, …' },
              { value: 'chineseCounting', label: '一, 二, 三, …' },
            ]}
            onPick={(v) => onChange({ ...value, fmt: v })}
          />
        </label>
        <label className="pgnum-row">
          {t('appStartAt')}
          <input
            type="number"
            min={0}
            placeholder={t('appContinueFromPrev')}
            value={value.start}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
          />
        </label>
        <p className="pgnum-hint">
          {t('appPgNumHintBlank')}
          {sectionCount > 1
            ? t('appPgNumAppliesTo', { n: Math.min(activeSection, sectionCount - 1) + 1 })
            : ''}
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>{t('appCancel')}</button>
          <button className="btn-primary" onClick={onApply}>
            {t('appOk')}
          </button>
        </div>
      </div>
    </div>
  )
}
