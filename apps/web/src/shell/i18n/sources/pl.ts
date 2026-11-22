import type { zh } from './zh'

export const pl = {
  srcAdvancedLegend: 'Ustawienia zaawansowane',
  srcTimezone: 'Strefa czasowa',
  srcTimezonePlaceholder: 'np. Asia/Shanghai',
  srcMaxRows: 'Maksymalna liczba zwracanych wierszy',
  srcMaxRowsAria: 'Maksymalna liczba wierszy zapytania',
  srcTimeout: 'Limit czasu zapytania (ms)',
  srcTimeoutAria: 'Limit czasu zapytania w milisekundach',
  srcTimeoutHint: '100–30000 ms; pozostaw puste, aby użyć domyślnych 5000.',
} satisfies Record<keyof typeof zh, string>
