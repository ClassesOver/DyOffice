import type { RealtimeClientMessage } from '../../../../../../packages/web-contracts/src/realtime.ts'
import type { RealtimeConnection, RealtimeRegistry } from './sessions.ts'
import type { RealtimeState, RealtimeSnapshot } from './state.ts'

import type { RealtimeCommands, TrustedEditorDispatch, EditorDispatchResult } from './commands.ts'
export type { TrustedEditorDispatch, EditorDispatchResult } from './commands.ts'
export type DispatchOutcome = { status: 'ok' } | { status: 'unauthorized' }
export function createRealtimeDispatcher({ registry, state, commands: writers }: { registry: RealtimeRegistry; state: RealtimeState; commands?: RealtimeCommands }) {
  const snapshotKey = (snapshot: RealtimeSnapshot) => JSON.stringify(snapshot)
  async function authorized(connection: RealtimeConnection, effect: Parameters<RealtimeState['withSnapshot']>[1], ids: readonly string[] = []): Promise<DispatchOutcome> {
    try {
      await state.withSnapshot(connection, effect, ids)
      return { status: 'ok' }
    } catch (error) {
      if (![401, 403, 404].includes((error as { statusCode?: number }).statusCode ?? 0)) throw error
      // This carries no file/lease/journal data. Never send a cached snapshot.
      registry.send(connection, { type: 'error', code: 'unauthorized' })
      connection.socket.close(4401, 'unauthorized')
      const timeout = setTimeout(() => connection.socket.terminate(), 1000); timeout.unref()
      return { status: 'unauthorized' }
    }
  }
  return {
    initialize: (connection: RealtimeConnection) => authorized(connection, snapshot => { registry.sendSnapshot(connection, snapshot, 'state') }),
    poll: (connection: RealtimeConnection) => authorized(connection, snapshot => {
      if (connection.snapshot && snapshotKey(connection.snapshot) !== snapshotKey(snapshot)) registry.sendSnapshot(connection, snapshot, 'file-event')
    }),
    async receive(connection: RealtimeConnection, message: RealtimeClientMessage | undefined): Promise<DispatchOutcome> {
      if (message?.type === 'register' || message?.type === 'ack') {
        const initial = await authorized(connection, () => {})
        if (initial.status !== 'ok') return initial
        let accepted = false
        try { accepted = writers ? await (message.type === 'register' ? writers.register(connection, message) : writers.acknowledge(connection, message)) : false }
        catch (error) {
          if ([401, 403, 404].includes((error as { statusCode?: number }).statusCode ?? 0)) return authorized(connection, () => {})
          if ((error as { statusCode?: number }).statusCode !== 409) throw error
        }
        return authorized(connection, () => { if (!accepted) registry.send(connection, { type: 'error', code: 'permission-denied' }) })
      }
      return authorized(connection, (snapshot, commands) => {
        if (!message) registry.send(connection, { type: 'error', code: 'invalid-message' })
        else if (message.type === 'ping') registry.send(connection, { type: 'pong' })
        else if (message.type === 'sync') registry.sendSnapshot(connection, snapshot, 'state')
        else registry.send(connection, { type: 'command-state', requestId: message.requestId, commands })
      }, message?.type === 'reconcile' ? message.commandIds : [])
    },
    /** Server-only API; there is no browser command/propose/approve decoder. */
    dispatchToEditor(command: TrustedEditorDispatch): Promise<EditorDispatchResult> {
      return writers ? writers.dispatchToEditor(command) : Promise.resolve({ status: 'unsupported' })
    },
  }
}
export type RealtimeDispatcher = ReturnType<typeof createRealtimeDispatcher>
