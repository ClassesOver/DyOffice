/** Deliberately narrower than the desktop classifier: HTML, Markdown and business
 * domain keywords alone do not enable personal skills in the Web assistant. */
export function classifyOfficeSkill(name: string, description: string, body = '') {
  const text = `${name}\n${description}\n${body}`
  if (/(?:^|[^a-z0-9])(?:html?|markdown|md)(?=$|[^a-z0-9])/i.test(text)) return {relevant: false, matched: [] as string[]}
  const matched = [
    {id: 'docx', pattern: /(?:^|[^a-z0-9])(?:docx|word)(?=$|[^a-z0-9])|文字处理/i},
    {id: 'xlsx', pattern: /(?:^|[^a-z0-9])(?:xlsx|excel|spreadsheets?)(?=$|[^a-z0-9])|电子表格/i},
    {id: 'pptx', pattern: /(?:^|[^a-z0-9])(?:pptx|powerpoint|presentations?)(?=$|[^a-z0-9])|演示文稿|幻灯片/i},
    {id: 'pdf', pattern: /(?:^|[^a-z0-9])pdf(?=$|[^a-z0-9])/i},
  ].filter(item => item.pattern.test(text)).map(item => item.id)
  return {relevant: matched.length > 0, matched}
}

export const OFFICE_SKILL_REQUIRED = '个人技能仅支持 Word（docx）、Excel（xlsx）、PowerPoint（pptx）和 PDF 相关内容。'
