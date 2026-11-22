import type { zh } from './zh'

export const id = {
  srcAdvancedLegend: 'Pengaturan lanjutan',
  srcTimezone: 'Zona waktu',
  srcTimezonePlaceholder: 'mis. Asia/Shanghai',
  srcMaxRows: 'Baris maksimum yang dikembalikan',
  srcMaxRowsAria: 'Baris kueri maksimum',
  srcTimeout: 'Batas waktu kueri (md)',
  srcTimeoutAria: 'Batas waktu kueri dalam milidetik',
  srcTimeoutHint: '100–30000 md; kosongkan untuk nilai bawaan 5000.',
} satisfies Record<keyof typeof zh, string>
