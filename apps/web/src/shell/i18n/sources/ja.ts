import type { zh } from './zh'

export const ja = {
  srcAdvancedLegend: '詳細設定',
  srcTimezone: 'タイムゾーン',
  srcTimezonePlaceholder: '例: Asia/Shanghai',
  srcMaxRows: '最大取得行数',
  srcMaxRowsAria: 'クエリの最大行数',
  srcTimeout: 'クエリのタイムアウト（ミリ秒）',
  srcTimeoutAria: 'クエリのタイムアウト（ミリ秒）',
  srcTimeoutHint: '100～30000 ミリ秒。空欄の場合は既定の 5000。',
} satisfies Record<keyof typeof zh, string>
