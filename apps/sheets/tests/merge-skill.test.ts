import { describe, expect, it, vi } from 'vitest'
import { createMergeSkill } from '../src/renderer/ai/merge-skill'

describe('createMergeSkill', () => {
  it('limits Web merge guidance and rejects unsupported attachments before importing', async () => {
    const mergePaths = vi.fn(async () => ({ importedSheets: 1, files: 1, sheetNames: ['Data'] }))
    for (const ext of ['xlsm', 'xls', 'csv', 'tsv']) {
      const skill = createMergeSkill({
        supportedMergeExtensions: () => ['xlsx'],
        getAttachments: () => [{ path: `web-attachment:source.${ext}`, name: `source.${ext}`, ext, sizeBytes: 42 }],
        mergePaths,
      })
      expect(skill.systemPrompt).toContain('xlsx')
      expect(skill.systemPrompt).not.toContain('xlsm')
      expect(skill.tools[0]!.description).not.toContain('xlsm')
      expect(JSON.stringify(skill.tools[0]!.inputSchema)).toContain('xlsx')
      for (const input of [{}, { indexes: [0] }]) {
        const result = await skill.executeTool({ id: 'merge', name: 'merge_attached_workbooks', input })
        expect(result.isError).toBe(true)
        expect(result.output).toContain('source.' + ext)
      }
    }
    expect(mergePaths).not.toHaveBeenCalled()
  })

  it('keeps the desktop attachment formats when the host supplies no restriction', async () => {
    const mergePaths = vi.fn(async () => ({ importedSheets: 5, files: 5, sheetNames: ['Data'] }))
    const skill = createMergeSkill({
      getAttachments: () => ['xlsx', 'xlsm', 'xls', 'csv', 'tsv'].map(ext => ({ path: `source.${ext}`, name: `source.${ext}`, ext, sizeBytes: 42 })),
      mergePaths,
    })
    const result = await skill.executeTool({ id: 'merge', name: 'merge_attached_workbooks', input: {} })
    expect(result.isError).not.toBe(true)
    expect(mergePaths).toHaveBeenCalledWith(['source.xlsx', 'source.xlsm', 'source.xls', 'source.csv', 'source.tsv'])
  })

  it('does not partially import a mixed selection containing an unsupported format', async () => {
    const mergePaths = vi.fn()
    const skill = createMergeSkill({
      supportedMergeExtensions: () => ['xlsx'],
      getAttachments: () => ['xlsx', 'csv'].map(ext => ({ path: `source.${ext}`, name: `source.${ext}`, ext, sizeBytes: 42 })),
      mergePaths,
    })
    const result = await skill.executeTool({ id: 'merge', name: 'merge_attached_workbooks', input: {} })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('No files were imported')
    expect(mergePaths).not.toHaveBeenCalled()
  })

  it('marks a successful merge as a workbook mutation', async () => {
    const skill = createMergeSkill({
      supportedMergeExtensions: () => ['xlsx'],
      getAttachments: () => [
        { path: 'web-attachment:source', name: 'source.xlsx', ext: 'xlsx', sizeBytes: 42 },
      ],
      mergePaths: vi.fn(async () => ({ importedSheets: 1, files: 1, sheetNames: ['Data'] })),
    })

    const result = await skill.executeTool({
      id: 'merge-1',
      name: 'merge_attached_workbooks',
      input: {},
    })

    expect(result.output).toContain('Merged 1 sheets from 1 files')
    expect(result.isError).not.toBe(true)
    expect(result.mutated).toBe(true)
  })
})
