import type { WorkspaceSourceResultArtifact, WorkspaceSourceResultList, WorkspaceSourceResultPage } from '../../../../packages/web-contracts/src/source-results.ts'
import type { SourceToolQueryOutcome } from '../../../../packages/web-contracts/src/source-tools.ts'

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>
export function createSourceResultsClient(request: Request) {
  const tool = <T>(name: string, args: object) => request<T>('/api/v1/workspace/source-tools/execute', 'POST', { name, arguments: args })
  return {
    query(sourceId: string, input: { sql?: string; sourceVersion?: number }) { return tool<SourceToolQueryOutcome>('sources.query', { sourceId, ...input }) },
    save(resultId: string, name: string, commandId: string) { return tool<WorkspaceSourceResultArtifact>('sources.save_result', { resultId, name, commandId }) },
    read(resultId: string, offset = 0) { return tool<WorkspaceSourceResultPage>('sources.read_result', { resultId, offset, limit: 1000 }) },
    list(after?: string) { return request<WorkspaceSourceResultList>('/api/v1/workspace/data-results' + (after ? '?after=' + encodeURIComponent(after) : '')) },
    async download(resultId: string) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(resultId)) throw Error('结果标识无效。')
      const snapshot = await request<unknown>('/api/v1/workspace/data-results/' + resultId + '/content')
      return JSON.stringify(snapshot)
    },
  }
}
export type SourceResultsClient = ReturnType<typeof createSourceResultsClient>
