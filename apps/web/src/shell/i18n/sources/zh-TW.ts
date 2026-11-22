import type { zh } from './zh'

export const zhTW = {
  srcAdvancedLegend: '進階設定',
  srcTimezone: '時區',
  srcTimezonePlaceholder: '例如 Asia/Shanghai',
  srcMaxRows: '最大傳回列數',
  srcMaxRowsAria: '查詢最大列數',
  srcTimeout: '查詢逾時（毫秒）',
  srcTimeoutAria: '查詢逾時毫秒數',
  srcTimeoutHint: '100–30000 毫秒，留空使用預設 5000。',
} satisfies Record<keyof typeof zh, string>
