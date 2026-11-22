import type { zh } from './zh'

export const pt = {
  srcAdvancedLegend: 'Configurações avançadas',
  srcTimezone: 'Fuso horário',
  srcTimezonePlaceholder: 'ex.: Asia/Shanghai',
  srcMaxRows: 'Máximo de linhas retornadas',
  srcMaxRowsAria: 'Máximo de linhas da consulta',
  srcTimeout: 'Tempo limite da consulta (ms)',
  srcTimeoutAria: 'Tempo limite da consulta em milissegundos',
  srcTimeoutHint: '100–30000 ms; deixe vazio para usar o padrão de 5000.',
} satisfies Record<keyof typeof zh, string>
