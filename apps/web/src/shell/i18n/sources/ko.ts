import type { zh } from './zh'

export const ko = {
  srcAdvancedLegend: '고급 설정',
  srcTimezone: '시간대',
  srcTimezonePlaceholder: '예: Asia/Shanghai',
  srcMaxRows: '최대 반환 행 수',
  srcMaxRowsAria: '쿼리 최대 행 수',
  srcTimeout: '쿼리 시간 제한(밀리초)',
  srcTimeoutAria: '쿼리 시간 제한(밀리초)',
  srcTimeoutHint: '100–30000밀리초, 비워 두면 기본값 5000을 사용합니다.',
} satisfies Record<keyof typeof zh, string>
