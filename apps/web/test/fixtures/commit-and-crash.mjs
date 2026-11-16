// Trusted controller crash fixture. These credentials never enter a native tool.
import { Pool } from 'pg'
import { createPrincipalTransactions } from '../../server/src/db/context.ts'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'
import { createFileService } from '../../server/src/modules/files/service.ts'
import { createLocalObjectStore } from '../../server/src/storage/local-dev.ts'
try {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.length>65536) throw new Error('Fixture input limit')
  }
  const input = JSON.parse(text)
  if (!/^\/dyoffice_test_rls_[a-f0-9]+$/.test(new URL(input.url).pathname)) throw new Error('Dedicated fixture database required')
  const underlying = new Pool({ connectionString: input.url,max: 1,connectionTimeoutMillis: 5000 })
  const pool = {
    query: (...args) => underlying.query(...args),
    async connect() {
      const connection = await underlying.connect()
      return {
        release: error => connection.release(error),
        async query(...args) {
          const result = await connection.query(...args)
          // The real database has committed. Die before the caller receives an
          // acknowledgement; no finally block or failure callback can run.
          if (args[0]==='COMMIT') process.exit(86)
          return result
        },
      }
    },
  }
  const transactions = createPrincipalTransactions({ pool,deploymentId: input.deploymentId })
  const objects = await createLocalObjectStore({ directory: input.directory })
  const files = createFileService({ transactions,objects })
  await createRevisionService({ transactions,objects,files }).commitRevision(input.auth,input.save)
  process.exit(84)
} catch { process.stderr.write('Controlled crash fixture failed\n'); process.exit(85) }
