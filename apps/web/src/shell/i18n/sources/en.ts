import type { zh } from './zh'

export const en = {
  srcAdvancedLegend: 'Advanced settings',
  srcTimezone: 'Time zone',
  srcTimezonePlaceholder: 'e.g. Asia/Shanghai',
  srcMaxRows: 'Maximum rows returned',
  srcMaxRowsAria: 'Maximum query rows',
  srcTimeout: 'Query timeout (ms)',
  srcTimeoutAria: 'Query timeout in milliseconds',
  srcTimeoutHint: '100–30000 ms; leave empty for the 5000 default.',
} satisfies Record<keyof typeof zh, string>
