import {applyAiPanelPrefs,setAiPanelOpenStorage} from '@genoffice/ui'
import {DEFAULT_AI_PANEL_PREFS, isAiFontSize, type AiPanelPrefs, type AiPanelSide} from '@genoffice/ui/ai-panel-prefs'
import type {AssistantPreferences} from '../../../../packages/web-contracts/src/preferences'
import {createLocalShellClient} from '../shell/local-client'
import {createLocalPreferencesSession} from '../shell/local-preferences-session'
import type {WorkspaceOpenFrame} from './browser-document-command'

const attributes = ['data-web-ai-panel-side', 'data-web-ai-font-size', 'data-web-ai-custom-font-size', 'data-web-ai-spellcheck', 'data-web-ai-open-in-new-docs']

/** Publish saved account preferences to a mounted workspace document. */
export function publishBrowserAssistantPreferences(root: HTMLElement, prefs: AssistantPreferences): void {
  root.dataset.webAiPanelSide = prefs.aiPanelSide ?? DEFAULT_AI_PANEL_PREFS.side
  root.dataset.webAiFontSize = prefs.aiFontSize ?? DEFAULT_AI_PANEL_PREFS.fontSize
  root.dataset.webAiCustomFontSize = String(prefs.aiCustomFontSize ?? DEFAULT_AI_PANEL_PREFS.customFontSize)
  root.dataset.webAiSpellcheck = String(prefs.aiSpellcheck ?? DEFAULT_AI_PANEL_PREFS.spellcheck)
  root.dataset.webAiOpenInNewDocs = String(prefs.aiOpenInNewDocs === true)
}

/** Apply account appearance on top of the editor's own dock state. */
export async function installBrowserAssistantPreferences(prefs: AssistantPreferences = {}, initial: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS) {
  const root = document.documentElement
  const client = createLocalShellClient()
  let panelPrefs = initial
  let standalone: ReturnType<typeof createLocalPreferencesSession> | undefined
  let scope: string | undefined
  let pendingScope: Promise<void> | undefined
  const loadScope = () => pendingScope ??= (async () => {
    const {deploymentId,user} = await client.request<{deploymentId:string;user:{id:string}}>('/api/v1/auth/me','GET',undefined,AbortSignal.timeout(4000))
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
    if (typeof deploymentId === 'string' && typeof user?.id === 'string' && uuid.test(deploymentId) && uuid.test(user.id)) scope = `dyoffice:assistant:${deploymentId}:${user.id}:`
  })().catch(() => {})
  setAiPanelOpenStorage({
    getItem: key => { try { return scope ? localStorage.getItem(scope+key) : null } catch { return null } },
    setItem: (key, value) => {
      const remember = () => { try { if (scope) localStorage.setItem(scope+key,value) } catch { /* Storage is optional. */ } }
      if (scope) remember()
      else void loadScope().then(remember)
    },
  })
  const withAppearance = (base = panelPrefs): AiPanelPrefs => {
    const {webAiPanelSide, webAiFontSize, webAiCustomFontSize, webAiSpellcheck, webAiOpenInNewDocs} = root.dataset
    return {
      ...base,
      side: webAiPanelSide === 'left' || webAiPanelSide === 'right' ? webAiPanelSide : prefs.aiPanelSide ?? base.side,
      fontSize: isAiFontSize(webAiFontSize) ? webAiFontSize : prefs.aiFontSize ?? base.fontSize,
      customFontSize: webAiCustomFontSize === undefined ? prefs.aiCustomFontSize ?? base.customFontSize : Number(webAiCustomFontSize),
      spellcheck: webAiSpellcheck === undefined ? prefs.aiSpellcheck ?? base.spellcheck : webAiSpellcheck === 'true',
      openInNewDocs: webAiOpenInNewDocs === undefined ? prefs.aiOpenInNewDocs === true : webAiOpenInNewDocs === 'true',
    }
  }
  const apply = () => {
    const next = withAppearance()
    if (next.openInNewDocs) void loadScope()
    applyAiPanelPrefs(next)
  }
  if (withAppearance().openInNewDocs) await loadScope()
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(apply).observe(root, {attributeFilter: attributes})
  }
  apply()
  return {
    withAppearance,
    async movePanel(side: AiPanelSide, proof: string | undefined): Promise<AiPanelPrefs> {
      if (!proof) throw new Error('Assistant session unavailable')
      let saved: AssistantPreferences
      if (window.parent !== window) {
        const frame = window.frameElement as WorkspaceOpenFrame | null
        if (!frame?.isConnected || frame.ownerDocument.defaultView !== window.parent || !frame.dyofficeSaveAssistantSide) throw new Error('Workspace session unavailable')
        saved = await frame.dyofficeSaveAssistantSide(side,proof)
      } else {
        const binding = await client.bindSession(proof)
        standalone ??= createLocalPreferencesSession(client)
        standalone.bind(binding)
        saved = await standalone.preferences.updatePreferences({aiPanelSide:side})
      }
      publishBrowserAssistantPreferences(root,saved)
      apply()
      return withAppearance()
    },
    updatePanelPrefs(patch: Partial<AiPanelPrefs>) {
      panelPrefs = {...panelPrefs, ...patch}
      const next = withAppearance()
      applyAiPanelPrefs(next)
      return next
    },
  }
}
