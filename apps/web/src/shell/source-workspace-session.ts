import {createSourcesClient} from './sources-client'
import {createSourceResultsClient} from './source-results-client'
import type {createLocalShellClient} from './local-client'

export async function createSourceWorkspaceSession(client: ReturnType<typeof createLocalShellClient>, expectedProof?: string) {
  const bound = await client.bindSession(expectedProof)
  return {bound, sources: createSourcesClient(bound.request), results: createSourceResultsClient(bound.request)}
}
