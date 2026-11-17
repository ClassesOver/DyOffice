import { createHash, randomBytes } from 'node:crypto'
import type { PrincipalTransactions } from '../../db/context.ts'
import { authError } from '../auth/sessions.ts'
import { authorize } from '../policy/authorize.ts'
import { uuid, scope } from '../files/queries.ts'
import { readRealtimeHead } from './state.ts'
import { REALTIME_TICKET_PATTERN } from '../../../../../../packages/web-contracts/src/realtime.ts'

export const REALTIME_TICKET_TTL_MS = 60_000
export const REALTIME_MAX_LIVE_TICKETS = 16
export const REALTIME_TICKET_CLEANUP_LIMIT = 64
const ticketHash = (ticket: string) => createHash('sha256').update(ticket).digest('hex')
export type TicketPrincipal = { deploymentId: string; userId: string; sessionId: string }
export type ConsumedTicket = TicketPrincipal & { fileId: string; editorId: string | null }

export function createTicketService({ transactions, ttlMs = REALTIME_TICKET_TTL_MS }: { transactions: PrincipalTransactions; ttlMs?: number }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > REALTIME_TICKET_TTL_MS) throw new Error('Invalid realtime ticket lifetime')
  return {
    async issue(token: string, identity: TicketPrincipal, fileId: string, editorId: string | null): Promise<string> {
      const file = uuid(fileId), editor = editorId === null ? null : uuid(editorId)
      const ticket = randomBytes(32).toString('base64url')
      await transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
        if (principal.deploymentId !== identity.deploymentId || principal.userId !== identity.userId || principal.sessionId !== identity.sessionId) throw authError()
        authorize(principal, 'files:read', { deploymentId: principal.deploymentId, ownerId: principal.userId })
        // All sessions of an owner serialize quota admission, including two processes.
        await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['realtime-tickets:' + principal.deploymentId + ':' + principal.userId])
        await readRealtimeHead(connection, principal, file)
        await connection.query(`WITH dead AS (
          SELECT deployment_id,ticket_hash FROM realtime_tickets WHERE deployment_id=$1 AND owner_id=$2
          AND (used_at IS NOT NULL OR expires_at<=statement_timestamp()) ORDER BY expires_at,ticket_hash LIMIT $3
          FOR UPDATE SKIP LOCKED
        ) DELETE FROM realtime_tickets t USING dead d WHERE t.deployment_id=d.deployment_id AND t.ticket_hash=d.ticket_hash`, [...scope(principal), REALTIME_TICKET_CLEANUP_LIMIT])
        const live = await connection.query('SELECT count(*)::integer AS count FROM realtime_tickets WHERE deployment_id=$1 AND owner_id=$2 AND used_at IS NULL AND expires_at>clock_timestamp()', scope(principal))
        if (live.rows[0].count >= REALTIME_MAX_LIVE_TICKETS) throw authError(429)
        await connection.query("INSERT INTO realtime_tickets(deployment_id,owner_id,session_id,file_id,editor_id,ticket_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 millisecond')", [...scope(principal), principal.sessionId, file, editor, ticketHash(ticket), ttlMs])
      })
      return ticket
    },
    async consume(token: string, identity: TicketPrincipal, ticket: string): Promise<ConsumedTicket | undefined> {
      if (!REALTIME_TICKET_PATTERN.test(ticket)) return undefined
      return transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
        if (principal.deploymentId !== identity.deploymentId || principal.userId !== identity.userId || principal.sessionId !== identity.sessionId) throw authError()
        authorize(principal, 'files:read', { deploymentId: principal.deploymentId, ownerId: principal.userId })
        // Include session in the UPDATE predicate: a wrong session cannot burn a ticket.
        const result = await connection.query<{ file_id: string; editor_id: string | null }>(
          'UPDATE realtime_tickets SET used_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND ticket_hash=$4 AND used_at IS NULL AND expires_at>clock_timestamp() RETURNING file_id,editor_id',
          [...scope(principal), principal.sessionId, ticketHash(ticket)])
        const row = result.rows[0]
        if (!row) return undefined
        await readRealtimeHead(connection, principal, row.file_id)
        return { deploymentId: principal.deploymentId, userId: principal.userId, sessionId: principal.sessionId, fileId: row.file_id, editorId: row.editor_id }
      })
    },
  }
}
export type TicketService = ReturnType<typeof createTicketService>
