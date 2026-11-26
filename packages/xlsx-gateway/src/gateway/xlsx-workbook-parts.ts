import { resolveRelTarget } from './xlsx-drawing-add.ts'
import { parseRelationships, type ParsedRelationship } from './xlsx-sheets.ts'

const WORKBOOK_PATH = 'xl/workbook.xml'
const WORKBOOK_RELS_PATH = 'xl/_rels/workbook.xml.rels'
const defaultParts = {
  sharedStrings: 'xl/sharedStrings.xml',
  styles: 'xl/styles.xml',
  theme: 'xl/theme/theme1.xml',
} as const
type WorkbookPart = keyof typeof defaultParts

export function isWorkbookSheetRelationship(relationship: ParsedRelationship): boolean {
  return !relationship.external && /\/(worksheet|chartsheet)$/.test(relationship.type)
}

/** Some producers write package-relative sheet targets without a leading slash. */
export function resolveWorkbookSheetTarget(target: string): string {
  return resolveRelTarget(WORKBOOK_PATH, target.trim().replace(/^xl[/\\]/, ''))
}

export function workbookPartPath(relationshipsXml: string, part: WorkbookPart): string {
  const relationship = parseRelationships(relationshipsXml).find(({ external, type }) =>
    !external && type.endsWith('/' + part),
  )
  return relationship ? resolveRelTarget(WORKBOOK_PATH, relationship.target) : defaultParts[part]
}

export async function readWorkbookPartPath(
  source: { has(path: string): Promise<boolean>; readText(path: string): Promise<string> },
  part: WorkbookPart,
): Promise<string> {
  const relationships = (await source.has(WORKBOOK_RELS_PATH))
    ? await source.readText(WORKBOOK_RELS_PATH)
    : ''
  return workbookPartPath(relationships, part)
}
