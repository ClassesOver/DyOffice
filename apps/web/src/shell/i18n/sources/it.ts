import type { zh } from './zh'

export const it = {
  srcAdvancedLegend: 'Impostazioni avanzate',
  srcTimezone: 'Fuso orario',
  srcTimezonePlaceholder: 'es. Asia/Shanghai',
  srcMaxRows: 'Numero massimo di righe restituite',
  srcMaxRowsAria: 'Numero massimo di righe della query',
  srcTimeout: 'Timeout della query (ms)',
  srcTimeoutAria: 'Timeout della query in millisecondi',
  srcTimeoutHint: '100–30000 ms; lascia vuoto per il valore predefinito di 5000.',
} satisfies Record<keyof typeof zh, string>
