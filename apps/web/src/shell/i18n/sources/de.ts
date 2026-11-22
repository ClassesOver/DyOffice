import type { zh } from './zh'

export const de = {
  srcAdvancedLegend: 'Erweiterte Einstellungen',
  srcTimezone: 'Zeitzone',
  srcTimezonePlaceholder: 'z. B. Asia/Shanghai',
  srcMaxRows: 'Maximal zurückgegebene Zeilen',
  srcMaxRowsAria: 'Maximale Abfragezeilen',
  srcTimeout: 'Abfrage-Zeitlimit (ms)',
  srcTimeoutAria: 'Abfrage-Zeitlimit in Millisekunden',
  srcTimeoutHint: '100–30000 ms; leer lassen für den Standardwert 5000.',
} satisfies Record<keyof typeof zh, string>
