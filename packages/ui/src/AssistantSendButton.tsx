import enabledIcon from './assets/send-enter-on.png'
import disabledIcon from './assets/send-enter-off.png'
import stopIcon from './assets/send-stop.png'
import './assistant-send-button.css'

export function AssistantSendButton({ label, disabled = false, stop = false, onClick }: {
  label: string
  disabled?: boolean
  stop?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={stop ? 'assistant-send-button ai-send-btn ai-stop-btn' : 'assistant-send-button ai-send-btn'} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <img src={stop ? stopIcon : disabled ? disabledIcon : enabledIcon} alt="" />
      <svg className="assistant-send-button-glyph" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        {stop
          ? <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
          : <path d="M20 5v6a3 3 0 0 1-3 3H4m5-5-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
    </button>
  )
}
