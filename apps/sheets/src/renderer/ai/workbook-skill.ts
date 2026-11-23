import type { AgentSkill } from '@genoffice/agent-core'
import basePrompt from './prompts/base.md?raw'
import { verifySheetsResponse } from './response-verify'
import { placeholderInstruction } from './redact'
import {
  WORKBOOK_TOOLS,
  buildWorkbookContext,
  executeWorkbookTool,
  type SheetsSkillDeps,
} from './tools'

/**
 * The workbook DSL as an AgentSkill: mirrors createDocsSkill's shape
 * (systemPrompt + tools + buildContext + executeTool) so it plugs into the
 * same packages/agent-core AgentLoop docx uses.
 *
 * Prompt layout: the always-loaded base prompt (prompts/base.md) stays small
 * — workflow, op catalog, cross-cutting discipline — while per-domain field
 * definitions and conventions live in prompts/guides/*.md, loaded on demand
 * via load_guide.
 *
 * The base prompt is imported raw and therefore fixed at build time, so the
 * placeholder section is a getter rather than a string: which labels exist is
 * a property of the open workbook, and a model told about a placeholder that
 * is not there — or not told about one that is — misreads the sheet either way.
 */
export function createWorkbookSkill(deps: SheetsSkillDeps): AgentSkill {
  return {
    id: 'sheets',
    get systemPrompt() {
      const index = deps.redactions?.()
      const labels = index?.isEmpty
        ? []
        : (deps.getActiveSheetInfo().sheets.flatMap((sheet) => index?.labelsFor(sheet.id) ?? []) ??
          [])
      const prompt = labels.length > 0 ? `${basePrompt}\n\n${placeholderInstruction(labels)}` : basePrompt
      const supported = deps.supportedCreateDocumentTypes?.()
      return supported === undefined ? prompt : `${prompt}\n\nHost capabilities: create_document only supports ${supported.join(', ') || 'no file types'}. Do not offer other formats. Follow its tool result for storage and delivery; do not assume a local default save folder.`
    },
    get tools() {
      const supported = deps.supportedCreateDocumentTypes?.()
      if (supported === undefined) return WORKBOOK_TOOLS
      if (!supported.length) return WORKBOOK_TOOLS.filter(tool => tool.name !== 'create_document')
      return WORKBOOK_TOOLS.map(tool => {
        if (tool.name !== 'create_document') return tool
        const schema = tool.inputSchema as {properties: Record<string, unknown>}
        const filteredTool = { ...tool }
        const sheetTypes = supported.filter(type => type === 'xlsx' || type === 'csv')
        const reportTypes = supported.filter(type => type === 'docx' || type === 'pdf')
        filteredTool.description = [
          'Create a standalone file; the current workbook is unchanged.',
          `Supported types on this host: ${supported.join(', ')}.`,
          ...(sheetTypes.length ? [`${sheetTypes.join('/')} export one worksheet (sheetId, optional title; omit content).`] : []),
          ...(reportTypes.length ? [`${reportTypes.join('/')} take a title and simple HTML content for a new report or summary.`] : []),
        ].join(' ')
        filteredTool.inputSchema = {
          ...schema,
          properties: {
            ...schema.properties,
            type: {type: 'string', enum: [...supported], description: `target file type (default '${supported[0]}')`},
            title: {type: 'string', description: 'File name without extension; required for authored documents, optional for worksheet exports'},
            content: {type: 'string', description: 'Simple HTML for authored documents. Omit for xlsx/csv worksheet exports'},
          },
        }
        return filteredTool
      })
    },
    buildContext: () => buildWorkbookContext(deps),
    executeTool: (call) => executeWorkbookTool(call, deps),
    executeScopedTool: (call) => executeWorkbookTool(call, {
      ...deps,
      getActiveSheetInfo() {
        const { selection, selectionFrozen, selectionColumns, ...info } = deps.getActiveSheetInfo()
        return info
      },
    }),
    verifyResponse: verifySheetsResponse,
  }
}
