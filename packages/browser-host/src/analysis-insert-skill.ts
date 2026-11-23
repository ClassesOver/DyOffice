import {sourceResultBase} from '../../web-contracts/src/source-results.ts'
import type { AgentSkill } from '../../agent-core/src/skill.ts'
import type { AgentToolDef, ToolExecution } from '../../agent-core/src/types.ts'
import type { AnalysisDocumentTarget, PreparedAnalysisContent } from '../../web-contracts/src/analysis-document.ts'
import type { createAnalysisDeliveryClient } from './analysis-delivery-client.ts'
import { withAnalysisProvenance } from './analysis-insert-provenance.ts'
import { imageAltText, prepareImageContent } from './analysis-image.ts'
import { QUERY_RESULT_MAX_BODY_ROWS, queryResultTable, type QueryResultPage } from './query-result-content.ts'

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>
type Deliveries = Pick<ReturnType<typeof createAnalysisDeliveryClient>, 'snapshot' | 'download'>
type Documents = { current(): AnalysisDocumentTarget | undefined }

export const ANALYSIS_INSERT_TOOLS = Object.freeze({ data: 'insert_data_result', image: 'insert_analysis_image' })
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg'])
/** The schema maximum is what every format can actually take (header and notes count against the row limit). */
const MAX_READ_ROWS = QUERY_RESULT_MAX_BODY_ROWS
const uuid = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' }

const DATA_TOOL: AgentToolDef = {
  name: 'insert_data_result',
  description: 'Insert a frozen query result (the artifact.resultId returned by execute_sql) into the open file as a native table: a Word table after the cursor paragraph, cells from the top-left of the current Excel selection (numbers stay numeric), or a table on the current slide. The values come from the stored snapshot, not from your text, so never retype query rows yourself. A header row with units and provenance notes (source, snapshot hash, row count, truncation, timezone) are added. Large results are refused rather than silently cut: aggregate in SQL, choose columns, or pass maxRows. The change is not saved; the normal document save applies.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['resultId'],
    properties: {
      resultId: uuid,
      columns: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256 }, maxItems: 64, description: 'Columns to insert, in order; default all columns of the result.' },
      maxRows: { type: 'integer', minimum: 1, maximum: MAX_READ_ROWS, description: 'Insert only the first N rows; the notes state how many rows were left out.' },
    },
  },
}
const IMAGE_TOOL: AgentToolDef = {
  name: 'insert_analysis_image',
  description: 'Insert a PNG or JPEG chart produced by a delegated Coding/Python task into the open file: a picture after the cursor paragraph in Word, or centred on the current slide in PowerPoint (aspect ratio kept). Pass an artifactId listed under "Analysis images" in the context; omit it to use the most recent one. The bytes are re-verified against the committed delivery; provenance notes are added below the image. The change is not saved; the normal document save applies.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { artifactId: uuid, alt: { type: 'string', maxLength: 500, description: 'Alternative text describing the chart.' } },
  },
}

const failed = (summary: string, output: string): ToolExecution => ({ output, isError: true, summary })
const message = (error: unknown) => error instanceof Error && error.message ? error.message : 'unavailable'

/**
 * Model-facing tools for putting analysis output into the open document. Data
 * reaches the document only through the server's frozen result or verified
 * artifact bytes and the editor's fenced AnalysisDocumentTarget, never through
 * model-transcribed values. Insertion is not a save.
 */
export function createAnalysisInsertSkill(o: {
  format: 'docx' | 'xlsx' | 'pptx'
  request: Request
  documents: Documents
  deliveries?: Deliveries
  dataResults: () => boolean
  images: () => boolean
  disposed: () => boolean
}): AgentSkill {
  const imageArtifacts = () => (o.deliveries?.snapshot() ?? []).flatMap(item =>
    item.receipt.artifacts.filter(file => IMAGE_TYPES.has(file.mediaType)).map(file => ({ commandId: item.receipt.commandId, createdAt: item.receipt.createdAt, file })))
  const dataOffered = () => o.dataResults()
  const imageOffered = () => o.format !== 'xlsx' && !!o.deliveries && o.images()

  /** prepare returns the content and the artifact identity it was built from (known only after the read). */
  async function insert(signal: AbortSignal | undefined, summary: string, prepare: (format: 'docx' | 'xlsx' | 'pptx',fileId:string) => Promise<{ content: PreparedAnalysisContent; artifact: { artifactId: string; sha256: string } }>): Promise<ToolExecution> {
    const target = o.documents.current()
    if (!target || target.format === 'pdf' || target.format !== o.format) return failed(summary, 'No editable document is open for insertion.')
    const authorized = () => !o.disposed() && !signal?.aborted && o.documents.current() === target
    let capture
    // Pin the document revision and selection before any network read.
    try { capture = target.capture() } catch { return failed(summary, 'The document is busy, read-only or being saved; try again when it is idle.') }
    let prepared: Awaited<ReturnType<typeof prepare>>
    try { prepared = await prepare(o.format,capture.fileId) } catch (error) { return failed(summary, message(error)) }
    if (!authorized()) return failed(summary, 'Stopped or the document changed; nothing was inserted.')
    try {
      const result = await target.apply(capture, prepared.content, prepared.artifact, authorized)
      if (result.status !== 'applied_uncommitted') throw new Error()
    } catch {
      return failed(summary, 'The document changed or the editor refused the insertion (for example the user edited it meanwhile); nothing was confirmed. Read the document before retrying.')
    }
    return { output: '', mutated: true, summary }
  }

  return {
    id: 'analysis-insert',
    get systemPrompt() {
      const lines: string[] = []
      if (dataOffered()) lines.push(`To put a query result into the file, call ${DATA_TOOL.name} with its artifact.resultId instead of retyping values. Aggregate in SQL first when the result is large.`)
      if (imageOffered()) lines.push(`To put a Coding/Python chart into the file, call ${IMAGE_TOOL.name}; only claim it is inserted after a successful result.`)
      return lines.join('\n')
    },
    get tools() {
      if (o.disposed()) return []
      return [...(dataOffered() ? [DATA_TOOL] : []), ...(imageOffered() ? [IMAGE_TOOL] : [])]
    },
    buildContext() {
      if (!imageOffered()) return ''
      const images = imageArtifacts().slice(-8)
      if (!images.length) return ''
      return 'Analysis images (insertable with ' + IMAGE_TOOL.name + '):\n' + images.map(({ file }) => `- ${file.name} · ${file.mediaType} · artifactId ${file.artifactId}`).join('\n')
    },
    async executeTool(call, signal) {
      if (o.disposed() || call.inputError || call.truncated || signal?.aborted) return failed(call.name, 'The tool was not executed.')
      const input = call.input ?? {}
      if (call.name === DATA_TOOL.name && dataOffered()) {
        const summary = 'Insert query result'
        const resultId = input.resultId
        if (typeof resultId !== 'string' || !UUID.test(resultId)) return failed(summary, 'resultId must be the artifact.resultId of a successful query.')
        if (input.columns !== undefined && (!Array.isArray(input.columns) || input.columns.some(name => typeof name !== 'string'))) return failed(summary, 'columns must be a list of column names.')
        if (input.maxRows !== undefined && (!Number.isInteger(input.maxRows) || (input.maxRows as number) < 1 || (input.maxRows as number) > MAX_READ_ROWS)) return failed(summary, `maxRows must be between 1 and ${MAX_READ_ROWS}.`)
        let inserted = ''
        const outcome = await insert(signal, summary, async (format,fileId) => {
          const pages: QueryResultPage[] = []
          const want = (input.maxRows as number | undefined) ?? MAX_READ_ROWS + 1
          for (let offset: number | null = 0; offset !== null && pages.reduce((n, page) => n + page.rows.length, 0) < want;) {
            const page: QueryResultPage = await o.request(`${sourceResultBase(fileId)}/data-results/${encodeURIComponent(resultId)}?offset=${offset}&limit=${Math.min(1000, want)}`)
            if (signal?.aborted || o.disposed()) throw new Error('Stopped; nothing was inserted.')
            pages.push(page)
            offset = page.nextOffset
          }
          const content = queryResultTable(pages, { ...(input.columns ? { columns: input.columns as string[] } : {}), ...(input.maxRows !== undefined ? { maxRows: input.maxRows as number } : {}) }, format)
          inserted = `${content.rows.length} table rows (header and notes included), ${pages[0]!.totalRows} rows in the frozen result`
          return { content, artifact: { artifactId: resultId.toLowerCase(), sha256: pages[0]!.sha256 } }
        })
        return outcome.isError ? outcome : { ...outcome, output: `Inserted ${inserted}. It is not saved yet; the document's normal save applies.` }
      }
      if (call.name === IMAGE_TOOL.name && imageOffered()) {
        const summary = 'Insert analysis image'
        const requested = input.artifactId
        if (requested !== undefined && (typeof requested !== 'string' || !UUID.test(requested))) return failed(summary, 'artifactId must be one listed under Analysis images.')
        const alt = typeof input.alt === 'string' ? input.alt.slice(0, 500) : ''
        const candidates = imageArtifacts()
        const chosen = requested === undefined ? candidates.at(-1) : candidates.find(item => item.file.artifactId === (requested as string).toLowerCase())
        if (!chosen) return failed(summary, requested === undefined ? 'No PNG or JPEG analysis image has been delivered yet.' : 'That artifact is not a delivered PNG or JPEG analysis image.')
        const outcome = await insert(signal, summary, async format => {
          const file = await o.deliveries!.download(chosen.commandId, chosen.file.artifactId)
          if (!file.current() || file.artifact.artifactId !== chosen.file.artifactId || file.artifact.sha256 !== chosen.file.sha256) throw new Error('The delivery changed; nothing was inserted.')
          const image = prepareImageContent(file.bytes, file.artifact.mediaType, imageAltText(alt) || imageAltText(file.artifact.name) || 'Analysis chart')
          return { content: withAnalysisProvenance(image, file.receipt, file.artifact, format), artifact: { artifactId: chosen.file.artifactId, sha256: chosen.file.sha256 } }
        })
        return outcome.isError ? outcome : { ...outcome, output: `Inserted the image ${chosen.file.name}. It is not saved yet; the document's normal save applies.` }
      }
      return failed(call.name, 'This tool is not available here.')
    },
  }
}
