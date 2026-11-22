import type { zh } from './zh'

export const th = {
  srcAdvancedLegend: 'การตั้งค่าขั้นสูง',
  srcTimezone: 'เขตเวลา',
  srcTimezonePlaceholder: 'เช่น Asia/Shanghai',
  srcMaxRows: 'จำนวนแถวสูงสุดที่ส่งกลับ',
  srcMaxRowsAria: 'จำนวนแถวสูงสุดของคิวรี',
  srcTimeout: 'เวลาหมดของคิวรี (มิลลิวินาที)',
  srcTimeoutAria: 'เวลาหมดของคิวรีเป็นมิลลิวินาที',
  srcTimeoutHint: '100–30000 มิลลิวินาที เว้นว่างเพื่อใช้ค่าเริ่มต้น 5000',
} satisfies Record<keyof typeof zh, string>
