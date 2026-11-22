import type { zh } from './zh'

export const es = {
  srcAdvancedLegend: 'Configuración avanzada',
  srcTimezone: 'Zona horaria',
  srcTimezonePlaceholder: 'p. ej. Asia/Shanghai',
  srcMaxRows: 'Máximo de filas devueltas',
  srcMaxRowsAria: 'Máximo de filas de consulta',
  srcTimeout: 'Tiempo de espera de la consulta (ms)',
  srcTimeoutAria: 'Tiempo de espera de la consulta en milisegundos',
  srcTimeoutHint: '100–30000 ms; déjelo vacío para usar el valor predeterminado de 5000.',
} satisfies Record<keyof typeof zh, string>
