import type { HarnessDescriptor } from '../../agent-core/src/coding-skill.ts'
import type { createCodingClient } from './coding.ts'
import type { AssistantChannelClient } from './assistant-channel.ts'
import type { TaskState } from '../../web-contracts/src/assistant-channel.ts'

export interface WorkspaceTarget {
  id: string
  name: string
  origin: 'office' | 'builtin' | 'external'
  available: boolean
  kind: 'office' | 'harness' | 'channel'
}
export interface TeamTask {
  id: string
  executionId: string
  agent: Pick<WorkspaceTarget, 'name' | 'origin'>
  targetId: string
  instruction: string
  state: TaskState
  savedRevision?:string|undefined
  summary?: string | undefined
  failure?: string | undefined
  output?: string | undefined
  progress?: string | undefined
  activity?: string | undefined
  initiator: 'office' | 'user' | 'external'
  kind: 'harness' | 'channel'
}
/** A one-shot request to reveal a task; each view consumes a given id once, so later tab or filter changes do not steal focus. */
export interface WorkspaceFocusRequest {
  id: number
  view: 'chat' | 'tasks'
  task: string
}
export function createAssistantWorkspace(options: {
  agents: readonly HarnessDescriptor[]
  coding?:
    | Pick<ReturnType<typeof createCodingClient>, 'run' | 'snapshot' | 'subscribe' | 'cancel'>
    | undefined
  channel?:
    Pick<AssistantChannelClient, 'snapshot' | 'subscribe' | 'error' | 'send' | 'cancel'> | undefined
}) {
  const office: WorkspaceTarget = {
    id: 'office',
    name: 'Office',
    origin: 'office',
    available: true,
    kind: 'office',
  }
  let selected = office,
    pending = false,
    notice = '',
    disposed = false
  let view: 'chat' | 'tasks' = 'chat',
    focusedTask = '',
    focusRequest: WorkspaceFocusRequest | null = null,
    focusRequests = 0
  const hiddenConversationTasks = new Set<string>()
  const visibleInConversation = (task: TeamTask) => !hiddenConversationTasks.has(task.id)
  const directChannelTasks = new Set<string>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const off = [options.coding?.subscribe(notify), options.channel?.subscribe(notify)]
  function targets(): WorkspaceTarget[] {
    const channel = options.channel?.snapshot()
    return [
      office,
      ...options.agents.map((agent) => ({
        id: 'harness:' + agent.id,
        name: agent.name,
        origin: agent.origin,
        available: !!options.coding && agent.capabilities.includes('coding'),
        kind: 'harness' as const,
      })),
      ...(channel?.members
        .filter((member) => !member.revoked)
        .map((member) => ({
          id: 'channel:' + member.membershipId,
          name: member.displayName,
          origin: 'external' as const,
          kind: 'channel' as const,
          available: member.online && !channel.paused && !options.channel?.error(),
        })) ?? []),
    ]
  }
  function teamTasks(): TeamTask[] {
    const channel = options.channel?.snapshot()
    return [
      ...(options.coding?.snapshot().map((task) => ({
        id: 'harness:' + task.id,
        executionId: task.id,
        targetId: 'harness:' + task.agent.id,
        agent: task.agent,
        instruction: task.instruction,
        state: task.state,
        summary: task.summary,
        failure: task.failure,
        output: task.output,
        progress: task.progress,
        activity: task.activity,
        initiator: task.initiator ?? 'office',
        kind: 'harness' as const,
      })) ?? []),
      ...(channel?.tasks.map((task) => ({
        id: 'channel:' + task.taskId,
        executionId: task.taskId,
        targetId: task.to === 'office' ? 'office' : 'channel:' + task.to,
        agent:
          task.to === 'office'
            ? office
            : {
                name:
                  channel.members.find((member) => member.membershipId === task.to)?.displayName ??
                  'Agent',
                origin: 'external' as const,
              },
        instruction: task.instruction,
        state: task.state,
        savedRevision:task.savedRevision,
        summary: task.summary ?? undefined,
        initiator: directChannelTasks.has(task.taskId)
          ? ('user' as const)
          : task.from === 'office'
            ? ('office' as const)
            : ('external' as const),
        kind: 'channel' as const,
      })) ?? []),
    ]
  }
  return {
    snapshot() {
      const tasks = teamTasks()
      return {
        targets: targets(),
        selected,
        pending,
        notice,
        tasks: options.coding?.snapshot() ?? [],
        channel: options.channel?.snapshot(),
        teamTasks: tasks,
        conversationTasks: tasks.filter(visibleInConversation),
        view,
        focusedTask,
        focusRequest,
      }
    },
    hasConversationTasks: () => teamTasks().some(visibleInConversation),
    resetConversationTasks() {
      for (const task of teamTasks()) hiddenConversationTasks.add(task.id)
      notify()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    isOffice: () => selected.kind === 'office',
    setView(next: 'chat' | 'tasks') {
      view = next
      notify()
    },
    openTask(id: string) {
      view = 'tasks'
      focusedTask = id
      focusRequest = { id: ++focusRequests, view: 'tasks', task: id }
      notify()
    },
    openConversation(id: string) {
      hiddenConversationTasks.delete(id)
      view = 'chat'
      focusedTask = id
      focusRequest = { id: ++focusRequests, view: 'chat', task: id }
      notify()
    },
    select(id: string) {
      const target = targets().find((target) => target.id === id)
      if (!target || !target.available || disposed) return
      selected = target
      notice = ''
      notify()
    },
    async submit(instruction: string, hasExtras: boolean): Promise<'office' | 'sent' | 'failed'> {
      if (selected.kind === 'office') return 'office'
      if (disposed) return 'failed'
      const target = targets().find((target) => target.id === selected.id)
      if (
        pending ||
        !instruction.trim() ||
        instruction.length > 16000 ||
        !target?.available ||
        hasExtras
      ) {
        notice = hasExtras
          ? 'extras'
          : pending
            ? 'busy'
            : instruction.length > 16000
              ? 'length'
              : 'unavailable'
        notify()
        return 'failed'
      }
      pending = true
      notice = ''
      notify()
      try {
        if (target.kind === 'harness')
          await options.coding!.run({ agentId: target.id.slice(8), instruction })
        else {
          const receipt = await options.channel!.send(target.id.slice(8), instruction)
          if (receipt?.taskId) directChannelTasks.add(receipt.taskId)
        }
        if (disposed) return 'failed'
        notice = 'sent'
        if (selected.id === target.id) selected = office
        return 'sent'
      } catch {
        if (!disposed) notice = 'failed'
        return 'failed'
      } finally {
        pending = false
        if (!disposed) notify()
      }
    },
    async cancelTask(id: string) {
      try {
        if (id.startsWith('harness:')) await options.coding?.cancel(id.slice(8))
        else if (id.startsWith('channel:')) await options.channel?.cancel(id.slice(8))
      } catch {
        notice = 'cancelFailed'
        notify()
      }
    },
    cancel(id: string) {
      return this.cancelTask('harness:'+id)
    },
    dispose() {
      disposed = true
      off.forEach((unsubscribe) => unsubscribe?.())
      listeners.clear()
    },
  }
}
export type AssistantWorkspaceClient = ReturnType<typeof createAssistantWorkspace>
