import {sourceResultBase} from '../../../../packages/web-contracts/src/source-results.ts'
import { zh } from './i18n/sources/zh'
import type { WorkspaceSourceResultArtifact, WorkspaceSourceResultList, WorkspaceSourceResultPage } from '../../../../packages/web-contracts/src/source-results.ts'
import type { SourceToolQueryOutcome } from '../../../../packages/web-contracts/src/source-tools.ts'

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>
const validId = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
/** zh text as the message; `sourcesKey` lets the panel show it in the UI language. */
const invalidId = () => Object.assign(Error(zh.drInvalidResultId), { sourcesKey: 'drInvalidResultId' as const })
export function createSourceResultsClient(request: Request, documentId?:string) {
  const base=sourceResultBase(documentId)
  const tool = <T>(name: string, args: object) => request<T>(base+'/source-tools/execute', 'POST', { name, arguments: args })
  return {
    query(sourceId: string, input: { sql?: string }) { return tool<SourceToolQueryOutcome>('sources.query', { sourceId, ...input }) },
    save(resultId: string, name: string, commandId: string) { return tool<WorkspaceSourceResultArtifact>('sources.save_result', { resultId, name, commandId }) },
    read(resultId: string, offset = 0) { return tool<WorkspaceSourceResultPage>('sources.read_result', { resultId, offset, limit: 1000 }) },
    list(after?: string) {
      const query = new URLSearchParams()
      if (after) query.set('after', after)
      if (documentId) query.set('includePending', 'true')
      return request<WorkspaceSourceResultList>(base+'/data-results'+(query.size ? '?'+query : ''))
    },
    /** Removes a saved result and frees its share of the workspace quota. */
    async remove(resultId: string) {
      if (!validId(resultId)) throw invalidId()
      await request<void>(base+'/data-results/' + resultId, 'DELETE')
    },
    async download(resultId: string) {
      if (!validId(resultId)) throw invalidId()
      const snapshot = await request<unknown>(base+'/data-results/' + resultId + '/content')
      return JSON.stringify(snapshot)
    },
  }
}
export type SourceResultsClient = ReturnType<typeof createSourceResultsClient>
