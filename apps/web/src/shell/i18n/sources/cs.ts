import type { zh } from './zh'

export const cs = {
  srcAdvancedLegend: 'Pokročilé nastavení',
  srcTimezone: 'Časové pásmo',
  srcTimezonePlaceholder: 'např. Asia/Shanghai',
  srcMaxRows: 'Maximální počet vrácených řádků',
  srcMaxRowsAria: 'Maximální počet řádků dotazu',
  srcTimeout: 'Časový limit dotazu (ms)',
  srcTimeoutAria: 'Časový limit dotazu v milisekundách',
  srcTimeoutHint: '100–30000 ms; ponechte prázdné pro výchozích 5000.',
} satisfies Record<keyof typeof zh, string>
