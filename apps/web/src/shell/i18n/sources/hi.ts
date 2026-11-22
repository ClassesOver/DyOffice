import type { zh } from './zh'

export const hi = {
  srcAdvancedLegend: 'उन्नत सेटिंग्स',
  srcTimezone: 'समय क्षेत्र',
  srcTimezonePlaceholder: 'जैसे Asia/Shanghai',
  srcMaxRows: 'अधिकतम लौटाई गई पंक्तियाँ',
  srcMaxRowsAria: 'क्वेरी की अधिकतम पंक्तियाँ',
  srcTimeout: 'क्वेरी टाइमआउट (मि.से.)',
  srcTimeoutAria: 'मिलीसेकंड में क्वेरी टाइमआउट',
  srcTimeoutHint: '100–30000 मि.से.; डिफ़ॉल्ट 5000 के लिए खाली छोड़ें।',
} satisfies Record<keyof typeof zh, string>
