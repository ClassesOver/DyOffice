import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal } from '../db/context.ts'
import { scope } from '../modules/files/queries.ts'

// Append on the business transaction. Dispatch/ack/retry belongs to T08;
// a durable intent is not evidence an external consumer already received it.
export async function appendRevisionEvent(connection: PoolClient, principal: BusinessPrincipal, event: { fileId: string; revision: string; baseRevision: string; source: 'save' | 'restore' }) {
  await connection.query("INSERT INTO revision_outbox(id,deployment_id,owner_id,file_id,revision_id,event_type,payload) VALUES($1,$2,$3,$4,$5,'file.revision.committed',$6::jsonb)", [randomUUID(),...scope(principal),event.fileId,event.revision,JSON.stringify(event)])
}
