/**
 * AI-driven workbook merging: the user
 * attaches spreadsheet files in the chat and asks the assistant to combine
 * them. The heavy lifting stays engine-side — the tool imports every sheet of
 * the chosen attachments into the current workbook through the same pipeline
 * as Data ▸ Merge Workbooks, and the model then works on the merged data with
 * the normal workbook tools (and create_document for new output files).
 */
import type { AgentSkill } from '@genoffice/agent-core'
import type { AttachmentMeta } from '../../shared/desktop-api'
import { SPREADSHEET_ATTACHMENT_EXTS } from '../../shared/attachment-formats'
import type { MergeSourcesResult } from '../merge-workbooks'

export { SPREADSHEET_ATTACHMENT_EXTS }

const mergeSystemPrompt = (extensions: readonly string[]) => `## Merging attached spreadsheets
When the user attaches spreadsheet files (${extensions.join('/')}) and asks to merge, combine, consolidate, or process them together:
- Call merge_attached_workbooks FIRST. It imports every sheet of the chosen attachments into the current workbook engine-side (fast, exact) and reports the new sheet names. Never reconstruct spreadsheet contents from read_attachment text for merging — that path is lossy and slow.
- Afterwards the data IS in the current workbook: use get_workbook_context / read_range / aggregate_range on the reported sheets, and create_document to emit new files if the user wants separate outputs.
- Formulas in the sources arrive as their computed values.`

/** attachment indexes that are spreadsheets (the tool's default selection) */
export function spreadsheetAttachmentIndexes(list: readonly AttachmentMeta[]): number[] {
  const indexes: number[] = []
  for (let index = 0; index < list.length; index += 1) {
    const attachment = list[index]
    if (attachment && SPREADSHEET_ATTACHMENT_EXTS.has(attachment.ext)) indexes.push(index)
  }
  return indexes
}

export interface MergeSkillDeps {
  supportedMergeExtensions?(): readonly string[] | undefined
  getAttachments(): readonly AttachmentMeta[]
  mergePaths(paths: string[]): Promise<MergeSourcesResult>
}

export function createMergeSkill(deps: MergeSkillDeps): AgentSkill {
  const supportedExtensions = () => deps.supportedMergeExtensions?.() ?? [...SPREADSHEET_ATTACHMENT_EXTS]
  return {
    id: 'workbook-merge',
    get systemPrompt() { return mergeSystemPrompt(supportedExtensions()) },
    get tools() { return [
      {
        name: 'merge_attached_workbooks',
        description:
          `Import every sheet of the attached spreadsheet files (${supportedExtensions().join('/')}) into the current workbook, engine-side. ` +
          'Returns the created sheet names. Use this before analyzing or restructuring attached spreadsheet data; ' +
          'never rebuild attachment contents cell-by-cell from text.',
        inputSchema: {
          type: 'object',
          properties: {
            indexes: {
              type: 'array',
              items: { type: 'integer' },
              description:
                `Attachment indexes to merge (0-based, from the attachment list). Supported formats: ${supportedExtensions().join(', ')}. Omit to merge every spreadsheet attachment.`,
            },
          },
          required: [],
        },
      },
    ] },
    executeTool: async (call) => {
      if (call.name !== 'merge_attached_workbooks') {
        return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
      }
      const list = deps.getAttachments()
      const requested = Array.isArray((call.input as { indexes?: unknown }).indexes)
        ? ((call.input as { indexes: unknown[] }).indexes.filter(
            (value) => Number.isInteger(value) && (value as number) >= 0,
          ) as number[])
        : spreadsheetAttachmentIndexes(list)
      const paths: string[] = []
      const skipped: string[] = []
      const supported = supportedExtensions()
      for (const index of requested) {
        const attachment = list[index]
        if (!attachment) {
          skipped.push(`#${index} (no such attachment)`)
        } else if (!SPREADSHEET_ATTACHMENT_EXTS.has(attachment.ext)) {
          skipped.push(`${attachment.name} (not a spreadsheet)`)
        } else if (!supported.includes(attachment.ext)) {
          return {
            output: `Cannot merge ${attachment.name}: this host supports ${supported.join(', ') || 'no spreadsheet formats'}. No files were imported.`,
            isError: true,
            summary: 'merge: unsupported format',
          }
        } else {
          paths.push(attachment.path)
        }
      }
      if (paths.length === 0) {
        return {
          output:
            `No spreadsheet attachments to merge. Ask the user to attach ${supported.join('/')} files first.`,
          isError: true,
          summary: 'merge: no sources',
        }
      }
      try {
        const result = await deps.mergePaths(paths)
        const lines = [
          `Merged ${result.importedSheets} sheets from ${result.files} files into the current workbook.`,
          `New sheets: ${result.sheetNames.join(', ')}`,
          'Source formulas were imported as computed values.',
        ]
        if (skipped.length > 0) lines.push(`Skipped: ${skipped.join('; ')}`)
        return {
          output: lines.join('\n'),
          mutated: true,
          summary: `merged ${result.importedSheets} sheets`,
        }
      } catch (error: unknown) {
        return {
          output: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          summary: 'merge failed',
        }
      }
    },
  }
}
