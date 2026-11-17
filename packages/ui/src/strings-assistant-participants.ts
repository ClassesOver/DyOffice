import type { Lang } from '@genoffice/i18n'

interface Labels { participants: string; office: string; builtin: string; external: string; manage: string }
export const ASSISTANT_PARTICIPANT_LABELS = {
  zh: { participants: '可用助手', office: 'Office 助手', builtin: '内置', external: '外部', manage: '管理 Agent' },
  en: { participants: 'Available assistants', office: 'Office assistant', builtin: 'Built-in', external: 'External', manage: 'Manage agents' },
  ja: { participants: '利用可能なアシスタント', office: 'Office アシスタント', builtin: '内蔵', external: '外部', manage: 'エージェント管理' },
  ko: { participants: '사용 가능한 도우미', office: 'Office 도우미', builtin: '내장', external: '외부', manage: '에이전트 관리' },
  fr: { participants: 'Assistants disponibles', office: 'Assistant Office', builtin: 'Intégré', external: 'Externe', manage: 'Gérer les agents' },
  de: { participants: 'Verfügbare Assistenten', office: 'Office-Assistent', builtin: 'Integriert', external: 'Extern', manage: 'Agents verwalten' },
  es: { participants: 'Asistentes disponibles', office: 'Asistente de Office', builtin: 'Integrado', external: 'Externo', manage: 'Gestionar agentes' },
  th: { participants: 'ผู้ช่วยที่พร้อมใช้งาน', office: 'ผู้ช่วย Office', builtin: 'ในตัว', external: 'ภายนอก', manage: 'จัดการเอเจนต์' },
  id: { participants: 'Asisten tersedia', office: 'Asisten Office', builtin: 'Bawaan', external: 'Eksternal', manage: 'Kelola agen' },
  ru: { participants: 'Доступные помощники', office: 'Помощник Office', builtin: 'Встроенный', external: 'Внешний', manage: 'Управление агентами' },
  ar: { participants: 'المساعدون المتاحون', office: 'مساعد Office', builtin: 'مدمج', external: 'خارجي', manage: 'إدارة الوكلاء' },
  pt: { participants: 'Assistentes disponíveis', office: 'Assistente do Office', builtin: 'Integrado', external: 'Externo', manage: 'Gerir agentes' },
  it: { participants: 'Assistenti disponibili', office: 'Assistente Office', builtin: 'Integrato', external: 'Esterno', manage: 'Gestisci agenti' },
  pl: { participants: 'Dostępni asystenci', office: 'Asystent Office', builtin: 'Wbudowany', external: 'Zewnętrzny', manage: 'Zarządzaj agentami' },
  cs: { participants: 'Dostupní asistenti', office: 'Asistent Office', builtin: 'Vestavěný', external: 'Externí', manage: 'Spravovat agenty' },
  nl: { participants: 'Beschikbare assistenten', office: 'Office-assistent', builtin: 'Ingebouwd', external: 'Extern', manage: 'Agents beheren' },
  ms: { participants: 'Pembantu tersedia', office: 'Pembantu Office', builtin: 'Terbina dalam', external: 'Luaran', manage: 'Urus ejen' },
  he: { participants: 'עוזרים זמינים', office: 'עוזר Office', builtin: 'מובנה', external: 'חיצוני', manage: 'ניהול סוכנים' },
  hi: { participants: 'उपलब्ध सहायक', office: 'Office सहायक', builtin: 'अंतर्निहित', external: 'बाहरी', manage: 'एजेंट प्रबंधित करें' },
  'zh-TW': { participants: '可用助理', office: 'Office 助理', builtin: '內建', external: '外部', manage: '管理 Agent' },
  vi: { participants: 'Trợ lý khả dụng', office: 'Trợ lý Office', builtin: 'Tích hợp', external: 'Bên ngoài', manage: 'Quản lý tác nhân' },
  tr: { participants: 'Kullanılabilir asistanlar', office: 'Office asistanı', builtin: 'Yerleşik', external: 'Harici', manage: 'Aracıları yönet' },
} satisfies Record<Lang, Labels>
