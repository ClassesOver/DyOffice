import type { zh } from './zh'

export const nl = {
  srcAdvancedLegend: 'Geavanceerde instellingen',
  srcTimezone: 'Tijdzone',
  srcTimezonePlaceholder: 'bijv. Asia/Shanghai',
  srcMaxRows: 'Maximaal aantal geretourneerde rijen',
  srcMaxRowsAria: 'Maximaal aantal queryrijen',
  srcTimeout: 'Querytime-out (ms)',
  srcTimeoutAria: 'Querytime-out in milliseconden',
  srcTimeoutHint: '100–30000 ms; laat leeg voor de standaardwaarde 5000.',
} satisfies Record<keyof typeof zh, string>
