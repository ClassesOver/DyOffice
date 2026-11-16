import { AI_PROVIDERS } from '../../../../../../packages/ai-provider/src/providers.ts'
import { AI_MEDIA_PROVIDERS, providerHasCapability } from '../../../../../../packages/ai-provider/src/media.ts'
import { AI_SEARCH_PROVIDERS } from '../../../../../../packages/ai-provider/src/search-settings.ts'
import { getProviderAdapter } from '../../../../../../packages/ai-provider/src/registry.ts'
import type { DecisionEndpoint } from '../../../../../shell/src/shared/home-api.ts'
import type { GlobalSettingKind, ProviderCatalogEntry } from '../../../../../../packages/web-contracts/src/settings.ts'

// The original Home decision catalog has no exported metadata constant. Its full
// DecisionEndpoint union checks this projection; no desktop engine is imported.
const decisionCatalog = {
  openrouter: ['Jev (OpenRouter)', 'https://openrouter.ai/api/alpha/decisions', 'typesafe/jev-1.13'],
  direct: ['Jev (TypeSafe API)', 'https://api.typesafe.ai/v1/systemone', 'jev-1.13.0'],
  perplexity: ['Perplexity (v1 27B)', 'https://api.perplexity.ai/v1/decisions', 'pplx-decider-v1-27b'],
  'perplexity-v12': ['Perplexity (v1.2)', 'https://api.perplexity.ai/v1/decisions', 'pplx-decider-v1.2'],
  'perplexity-flash': ['Perplexity (Flash v1.2)', 'https://api.perplexity.ai/v1/decisions', 'pplx-decider-flash-v1.2'],
  liquid: ['Liquid AI (d1)', 'https://api.liquid.ai/decisions/v1/systemone', 'd1'],
  'liquid-ultra': ['Liquid AI (d1-ultra)', 'https://api.liquid.ai/decisions/v1/systemone', 'd1-ultra'],
  openai: ['OpenAI (gpt-6-luna)', 'https://api.openai.com/v1/decisions', 'gpt-6-luna'],
  gemini: ['Google (gemini-decision-1)', 'https://generativelanguage.googleapis.com/v1beta/decisions', 'gemini-decision-1'],
  cloudflare: ['Cloudflare (Clef)', '', '@cf/cloudflare/clef'],
  'cloudflare-flash': ['Cloudflare (Clef-flash)', '', '@cf/cloudflare/clef-flash'],
  kev: ['Kev (local)', 'http://127.0.0.1:8009/v1/systemone', 'kev-latest'],
  rizzo: ['Rizzo Flow (local)', 'http://127.0.0.1:8017/v1/systemone', 'rizzo-latest'],
  custom: ['Custom (/v1/systemone)', '', ''],
} satisfies Record<DecisionEndpoint, [string, string, string]>
const unavailable = { available: false, unavailableReason: 'Requires desktop account authorization; unavailable in this Web runtime' }
const catalog: ProviderCatalogEntry[] = [
  ...AI_PROVIDERS.map(meta => ({
    id: meta.id, label: meta.label, kinds: ['chat'] as GlobalSettingKind[], models: [...meta.models],
    defaultBaseUrl: ['genspark','codex','custom'].includes(meta.id) ? '' : getProviderAdapter(meta.id).resolveEndpoint({ apiKey: '', model: meta.defaultModel }).baseUrl,
    ...(['genspark','codex'].includes(meta.id) ? unavailable : { available: true }),
  })),
  ...AI_MEDIA_PROVIDERS.flatMap(meta => {
    const entry = (kind: GlobalSettingKind, models: string[], defaultModel: string): ProviderCatalogEntry => ({
      id: meta.id, label: meta.label, kinds: [kind],
      models: [...new Set([...(defaultModel ? [defaultModel] : []),...models])], defaultBaseUrl: meta.defaultBaseUrl,
      ...(meta.id === 'genspark' ? unavailable : { available: true }),
    })
    return [
      ...(providerHasCapability(meta, 'image') ? [entry('image_generation', meta.imageModels, meta.defaultImageModel)] : []),
      ...(providerHasCapability(meta, 'analysis') ? [entry('image_analysis', meta.analysisModels, meta.defaultAnalysisModel)] : []),
      ...(providerHasCapability(meta, 'video') ? [entry('video_analysis', meta.analysisModels, meta.defaultAnalysisModel)] : []),
    ]
  }),
  ...AI_SEARCH_PROVIDERS.map(meta => ({ id: meta.id, label: meta.label, kinds: ['web_search',...(meta.imageSearch ? ['image_search'] : [])] as GlobalSettingKind[], models: [], defaultBaseUrl: '', ...(meta.id === 'genspark' ? unavailable : { available: true }) })),
  ...Object.entries(decisionCatalog).map(([id,[label,defaultBaseUrl,model]]) => ({ id, label, kinds: ['rerank'] as GlobalSettingKind[], models: model ? [model] : [], defaultBaseUrl, available: true })),
  { id: 'http', label: 'Streamable HTTP MCP', kinds: ['http_mcp'], models: [], defaultBaseUrl: '', available: true },
]
/** Static provider descriptions only; never desktop settings, account tokens or environment keys. */
export const getProviderCatalog = (): ProviderCatalogEntry[] => structuredClone(catalog)
export function findProvider(kind: GlobalSettingKind, id: string) { return catalog.find(meta => meta.id === id && meta.kinds.includes(kind)) }

