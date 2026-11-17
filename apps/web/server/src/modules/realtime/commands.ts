import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import type { CommandEnvelope, ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import { REALTIME_MAX_MESSAGE_BYTES, decodeRealtimeServerMessage, type RealtimeCommandDelivery, type RealtimeDeliveryAck, type RealtimeRegistration } from '../../../../../../packages/web-contracts/src/realtime.ts'
import { authError, tokenHash } from '../auth/sessions.ts'
import { authorize } from '../policy/authorize.ts'
import { scope } from '../files/queries.ts'
import { assertLiveLease } from '../leases/queries.ts'
import { commandError, snapshotCommand, snapshotTool } from '../commands/approval.ts'
import { createPostgresCommandJournal } from '../commands/postgres-journal.ts'
import { createCommandService } from '../commands/service.ts'
import type { CommandJournal, CommandRecord } from '../commands/journal.ts'
import { isCurrentEditor, readRealtimeHead, type RealtimeState } from './state.ts'
import type { RealtimeConnection, RealtimeRegistry } from './sessions.ts'

export interface RealtimeCommandPolicy {
  /** Trusted composition only. Browser capabilities cannot create descriptors. */
  lookupTool(name: string): ToolDescriptor | undefined
  /** Fixed registered executor schema validation, never client-provided code. */
  validateCommand(envelope: CommandEnvelope): boolean
}
export type TrustedEditorDispatch = Readonly<{
  senderToken: string
  connectionId: string
  epoch: string
  envelope: CommandEnvelope
  digest: string
}>
export type EditorDispatchResult =
  | { status: 'unsupported' | 'unavailable' | 'unauthorized' | 'conflict' }
  | { status: 'delivered' | 'unknown_outcome'; commandId: string; deliveryId: string; claimId: string }

type RoutingReceipt = {
  editor_id: string; connection_id: string; connection_epoch: string; editor_generation: string
  lease_epoch: string; base_revision: string; delivery_id: string; claim_id: string; digest: string
  record: CommandRecord
}
export function createRealtimeCommands({ transactions, registry, state, policy, ackTimeoutMs = 5000 }: {
  transactions: PrincipalTransactions; registry: RealtimeRegistry; state: RealtimeState; policy?: RealtimeCommandPolicy; ackTimeoutMs?: number
}) {
  if (!Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 1 || ackTimeoutMs > 30_000) throw new Error('Invalid realtime delivery timeout')
  const approvedTool = (name: string): ToolDescriptor => snapshotTool(policy?.lookupTool(name), name)
  const matches = (connection: RealtimeConnection, registration: RealtimeRegistration, envelope: CommandEnvelope) =>
    !connection.closed && connection.socket.readyState === 1 && connection.registration === registration &&
    registration.baseRevision === envelope.baseRevision && registration.editorGeneration === envelope.editorGeneration &&
    registration.leaseEpoch === envelope.leaseEpoch && registration.capabilities.includes(envelope.payload.toolName as string)
  const currentSession = async (c: PoolClient, p: BusinessPrincipal, token: string) => {
    const result = await c.query('SELECT * FROM lock_business_session($1::uuid,$2::text,$3::bigint)', [p.deploymentId, tokenHash(token), transactions.sessionIdleMs])
    if (!result.rowCount) throw authError()
  }
  async function withRouting<T>(connection: RealtimeConnection, delivery: { deliveryId: string; commandId: string; claimId: string }, effect: (row: RoutingReceipt) => T): Promise<T> {
    return transactions.withPrincipalTransaction({ kind: 'session', token: connection.token }, async (c, p) => {
      if (p.deploymentId !== connection.deploymentId || p.userId !== connection.userId || p.sessionId !== connection.sessionId || !connection.editorId) throw authError()
      authorize(p, 'files:write', { deploymentId: p.deploymentId, ownerId: p.userId })
      const head = await readRealtimeHead(c, p, connection.fileId)
      // Lock before the joined read so a waited-for state change is observed
      // under a fresh statement snapshot, not an old joined tuple.
      await c.query('SELECT command_id FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4 FOR SHARE', [...scope(p), p.sessionId, delivery.commandId])
      const result = await c.query<RoutingReceipt>(`SELECT d.*,j.record FROM realtime_command_deliveries d JOIN command_journal j
        ON j.deployment_id=d.deployment_id AND j.owner_id=d.owner_id AND j.session_id=d.session_id AND j.command_id=d.command_id AND j.file_id=d.file_id
        WHERE d.deployment_id=$1 AND d.owner_id=$2 AND d.session_id=$3 AND d.file_id=$4 AND d.command_id=$5`,
      [...scope(p), p.sessionId, connection.fileId, delivery.commandId])
      const row = result.rows[0], registration = connection.registration
      if (!row || !registration || row.connection_id !== connection.connectionId || row.connection_epoch !== connection.epoch ||
        row.editor_id !== connection.editorId || row.delivery_id !== delivery.deliveryId || row.claim_id !== delivery.claimId ||
        row.base_revision !== head || row.record.state !== 'unknown_outcome' || row.record.operation !== 'apply' ||
        row.record.claimId !== delivery.claimId || row.record.digest !== row.digest || !matches(connection, registration, row.record.envelope) ||
        Number(row.editor_generation) !== registration.editorGeneration || Number(row.lease_epoch) !== registration.leaseEpoch) throw commandError('Stale delivery binding')
      approvedTool(row.record.envelope.payload.toolName as string)
      if (!policy?.validateCommand(row.record.envelope)) throw commandError('Unregistered command schema')
      await assertLiveLease(c, p, connection.fileId, Number(row.lease_epoch), connection.editorId)
      await currentSession(c, p, connection.token)
      return effect(row)
    })
  }
  return {
    register(connection: RealtimeConnection, request: RealtimeRegistration): Promise<boolean> {
      return state.withSnapshot(connection, snapshot => {
        if (!isCurrentEditor(connection, snapshot.lease) || request.baseRevision !== snapshot.headRevision || request.leaseEpoch !== snapshot.lease.leaseEpoch ||
          connection.dispatching || connection.pendingDelivery || (connection.registration && request.editorGeneration < connection.registration.editorGeneration)) return false
        for (const capability of request.capabilities) approvedTool(capability)
        if (request.capabilities.length && !policy) return false
        connection.registration = Object.freeze({ requestId: request.requestId, baseRevision: request.baseRevision,
          editorGeneration: request.editorGeneration, leaseEpoch: request.leaseEpoch, capabilities: Object.freeze([...request.capabilities]) })
        return registry.send(connection, { type: 'registered', ...connection.registration, connectionId: connection.connectionId, epoch: connection.epoch })
      })
    },
    async acknowledge(connection: RealtimeConnection, ack: RealtimeDeliveryAck): Promise<boolean> {
      const pending = connection.pendingDelivery
      if (!pending || ack.connectionId !== connection.connectionId || ack.epoch !== connection.epoch || ack.deliveryId !== pending.deliveryId ||
        ack.commandId !== pending.commandId || ack.claimId !== pending.claimId) return false
      return withRouting(connection, pending, () => {
        if (connection.pendingDelivery !== pending) return false
        pending.settle(true)
        return true
      })
    },
    dispatchToEditor(input: TrustedEditorDispatch): Promise<EditorDispatchResult> {
      if (!policy) return Promise.resolve({ status: 'unsupported' })
      // Snapshot caller arguments before the first await; no mutable envelope race.
      let envelope: CommandEnvelope
      try { envelope = snapshotCommand(input.envelope); approvedTool(envelope.payload.toolName as string) }
      catch { return Promise.resolve({ status: 'conflict' }) }
      if (!/^[a-f0-9]{64}$/.test(input.digest) || !policy.validateCommand(envelope)) return Promise.resolve({ status: 'conflict' })
      const connection = registry.find(input.connectionId), registration = connection?.registration
      if (!connection || !registration || connection.epoch !== input.epoch || !connection.editorId || connection.fileId !== envelope.fileId || connection.dispatching || connection.pendingDelivery || !matches(connection, registration, envelope)) return Promise.resolve({ status: 'unavailable' })
      const senderToken = input.senderToken, digest = input.digest, deliveryId = randomUUID()
      const probeMessage: RealtimeCommandDelivery = { type: 'command', connectionId: connection.connectionId, epoch: connection.epoch, editorId: connection.editorId,
        deliveryId, claimId: randomUUID(), digest, envelope }
      if (!decodeRealtimeServerMessage(JSON.stringify(probeMessage))) return Promise.resolve({ status: 'conflict' })
      connection.dispatching = true
      const work = async (): Promise<EditorDispatchResult> => {
        let claimId: string | undefined
        try {
          // Reuse T14 service for every approval/digest/policy/state transition.
          // The scoped transaction wrapper atomically adds routing after the claim.
          const boundTransactions: PrincipalTransactions = {
            sessionIdleMs: transactions.sessionIdleMs,
            withPrincipalTransaction: (credential, operation) => transactions.withPrincipalTransaction(credential, async (c, p) => {
              if (p.deploymentId !== connection.deploymentId || p.userId !== connection.userId || p.sessionId !== connection.sessionId || !matches(connection, registration, envelope)) throw authError()
              const value = await operation(c, p)
              const row = (await c.query<{ record: CommandRecord }>('SELECT record FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4 AND file_id=$5', [...scope(p), p.sessionId, envelope.commandId, envelope.fileId])).rows[0]?.record
              if (!row || row.state !== 'unknown_outcome' || row.operation !== 'apply' || !row.claimId || !matches(connection, registration, envelope)) throw commandError('Claim lost connection authority')
              await c.query(`INSERT INTO realtime_command_deliveries(deployment_id,owner_id,session_id,command_id,file_id,editor_id,connection_id,connection_epoch,editor_generation,lease_epoch,base_revision,delivery_id,claim_id,digest)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [...scope(p), p.sessionId, envelope.commandId, envelope.fileId, connection.editorId, connection.connectionId, connection.epoch,
              envelope.editorGeneration, envelope.leaseEpoch, envelope.baseRevision, deliveryId, row.claimId, digest])
              return value
            }),
          }
          const adapter = createPostgresCommandJournal({ transactions: boundTransactions, token: senderToken, editorId: connection.editorId!, editorGeneration: registration.editorGeneration })
          // No proposal/approval entrypoint is exposed from realtime.
          const journal: CommandJournal = { withAuthorizedCommand: adapter.withAuthorizedCommand }
          const service = createCommandService({ journal, lookupTool: policy.lookupTool })
          const claimed = await service.beginExecution(envelope, digest)
          claimId = claimed.claimId!
          const delivery = { commandId: envelope.commandId, deliveryId, claimId }
          const message: RealtimeCommandDelivery = { type: 'command', connectionId: connection.connectionId, epoch: connection.epoch,
            editorId: connection.editorId!, deliveryId, claimId, digest: claimed.digest, envelope: claimed.envelope }
          if (Buffer.byteLength(JSON.stringify(message)) > REALTIME_MAX_MESSAGE_BYTES) return { status: 'unknown_outcome', ...delivery }
          const accepted = registry.expectDelivery(connection, delivery, ackTimeoutMs)
          let sent = false
          try { sent = await withRouting(connection, delivery, () => registry.send(connection, message)) }
          catch { connection.pendingDelivery?.settle(false) }
          if (!sent) connection.pendingDelivery?.settle(false)
          return { status: await accepted ? 'delivered' : 'unknown_outcome', ...delivery }
        } catch (error) {
          if (claimId) return { status: 'unknown_outcome', commandId: envelope.commandId, deliveryId, claimId }
          return { status: (error as { statusCode?: number }).statusCode === 401 ? 'unauthorized' : 'conflict' }
        } finally { connection.dispatching = false }
      }
      return registry.track(work())
    },
  }
}
export type RealtimeCommands = ReturnType<typeof createRealtimeCommands>
