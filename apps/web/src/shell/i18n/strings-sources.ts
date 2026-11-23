import { createI18n, defineStrings } from '@genoffice/i18n'
import { zh } from './sources/zh'
import { en } from './sources/en'
import { ja } from './sources/ja'
import { ko } from './sources/ko'
import { fr } from './sources/fr'
import { de } from './sources/de'
import { es } from './sources/es'
import { th } from './sources/th'
import { id } from './sources/id'
import { ru } from './sources/ru'
import { ar } from './sources/ar'
import { pt } from './sources/pt'
import { it } from './sources/it'
import { pl } from './sources/pl'
import { cs } from './sources/cs'
import { nl } from './sources/nl'
import { ms } from './sources/ms'
import { he } from './sources/he'
import { hi } from './sources/hi'
import { zhTW } from './sources/zh-TW'
import { vi } from './sources/vi'
import { tr } from './sources/tr'

/** Data connections panel strings, sharded per locale under ./sources. */
export const sourcesStrings = defineStrings({
  zh,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  th,
  id,
  ru,
  ar,
  pt,
  it,
  pl,
  cs,
  nl,
  ms,
  he,
  hi,
  'zh-TW': zhTW,
  vi,
  tr,
})

export type SourcesStringKey = keyof typeof sourcesStrings.zh
export const translateSources = createI18n(sourcesStrings)
