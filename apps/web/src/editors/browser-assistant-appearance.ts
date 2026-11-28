import {applyAiPanelPrefs} from '@genoffice/ui'
import {DEFAULT_AI_PANEL_PREFS, isAiFontSize, type AiPanelPrefs} from '@genoffice/ui/ai-panel-prefs'
import type {AssistantAppearance} from '../../../../packages/web-contracts/src/preferences'

const attributes = ['data-web-ai-font-size', 'data-web-ai-custom-font-size', 'data-web-ai-spellcheck']

/** Publish saved account preferences to a mounted workspace document. */
export function publishBrowserAssistantAppearance(root: HTMLElement, prefs: AssistantAppearance): void {
  root.dataset.webAiFontSize = prefs.aiFontSize ?? DEFAULT_AI_PANEL_PREFS.fontSize
  root.dataset.webAiCustomFontSize = String(prefs.aiCustomFontSize ?? DEFAULT_AI_PANEL_PREFS.customFontSize)
  root.dataset.webAiSpellcheck = String(prefs.aiSpellcheck ?? DEFAULT_AI_PANEL_PREFS.spellcheck)
}

/** Apply account appearance on top of the editor's own dock state. */
export function installBrowserAssistantAppearance(prefs: AssistantAppearance = {}, initial: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS) {
  const root = document.documentElement
  let panelPrefs = initial
  const withAppearance = (base = panelPrefs): AiPanelPrefs => {
    const {webAiFontSize, webAiCustomFontSize, webAiSpellcheck} = root.dataset
    return {
      ...base,
      fontSize: isAiFontSize(webAiFontSize) ? webAiFontSize : prefs.aiFontSize ?? base.fontSize,
      customFontSize: webAiCustomFontSize === undefined ? prefs.aiCustomFontSize ?? base.customFontSize : Number(webAiCustomFontSize),
      spellcheck: webAiSpellcheck === undefined ? prefs.aiSpellcheck ?? base.spellcheck : webAiSpellcheck === 'true',
    }
  }
  const apply = () => applyAiPanelPrefs(withAppearance())
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(apply).observe(root, {attributeFilter: attributes})
  }
  apply()
  return {
    withAppearance,
    updatePanelPrefs(patch: Partial<AiPanelPrefs>) {
      panelPrefs = {...panelPrefs, ...patch}
      const next = withAppearance()
      applyAiPanelPrefs(next)
      return next
    },
  }
}
