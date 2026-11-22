import type { zh } from './zh'

export const ru = {
  srcAdvancedLegend: 'Дополнительные параметры',
  srcTimezone: 'Часовой пояс',
  srcTimezonePlaceholder: 'напр. Asia/Shanghai',
  srcMaxRows: 'Максимум возвращаемых строк',
  srcMaxRowsAria: 'Максимум строк запроса',
  srcTimeout: 'Тайм-аут запроса (мс)',
  srcTimeoutAria: 'Тайм-аут запроса в миллисекундах',
  srcTimeoutHint: '100–30000 мс; оставьте пустым для значения по умолчанию 5000.',
} satisfies Record<keyof typeof zh, string>
