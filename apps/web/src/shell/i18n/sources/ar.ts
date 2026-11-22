import type { zh } from './zh'

export const ar = {
  srcAdvancedLegend: 'الإعدادات المتقدمة',
  srcTimezone: 'المنطقة الزمنية',
  srcTimezonePlaceholder: 'مثل Asia/Shanghai',
  srcMaxRows: 'الحد الأقصى للصفوف المُرجعة',
  srcMaxRowsAria: 'الحد الأقصى لصفوف الاستعلام',
  srcTimeout: 'مهلة الاستعلام (مللي ثانية)',
  srcTimeoutAria: 'مهلة الاستعلام بالمللي ثانية',
  srcTimeoutHint: 'من 100 إلى 30000 مللي ثانية؛ اتركه فارغًا لاستخدام القيمة الافتراضية 5000.',
} satisfies Record<keyof typeof zh, string>
