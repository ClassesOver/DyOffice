import type { PrincipalTransactions } from '../../db/context.ts'
import type { ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import { createCommandService } from './service.ts'
import { createPostgresCommandJournal } from './postgres-journal.ts'
/** Trusted server registry only; the empty registry denies every command. No
 * app.ts mount: production requires a verified editor adapter and approval UI. */
export function createCommandRequestFactory(
  transactions: PrincipalTransactions,
  lookupTool: (name: string) => ToolDescriptor | undefined = () => undefined,
) {
  return (context: { token: string; editorId: string; editorGeneration: number }) => {
    const journal = createPostgresCommandJournal({ transactions, ...context })
    return {
      service: createCommandService({ journal, lookupTool }),
      bindCommandUpload: journal.bindCommandUpload,
    }
  }
}
