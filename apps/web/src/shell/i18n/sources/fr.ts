import type { zh } from './zh'

export const fr = {
  srcAdvancedLegend: 'Paramètres avancés',
  srcTimezone: 'Fuseau horaire',
  srcTimezonePlaceholder: 'ex. Asia/Shanghai',
  srcMaxRows: 'Nombre maximal de lignes renvoyées',
  srcMaxRowsAria: 'Nombre maximal de lignes de requête',
  srcTimeout: 'Délai de requête (ms)',
  srcTimeoutAria: 'Délai de requête en millisecondes',
  srcTimeoutHint: '100–30000 ms ; laisser vide pour la valeur par défaut de 5000.',
} satisfies Record<keyof typeof zh, string>
