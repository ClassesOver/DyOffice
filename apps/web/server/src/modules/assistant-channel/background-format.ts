export type BackgroundFormat='docx'|'xlsx'|'pptx'|'pdf'
export function isBackgroundFormat(format:string):format is BackgroundFormat {return ['docx','xlsx','pptx','pdf'].includes(format)}
