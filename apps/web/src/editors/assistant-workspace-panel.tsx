import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type KeyboardEvent,
} from 'react'
import { AssistantAvatar } from '@genoffice/ui'
import type {
  AssistantWorkspaceClient,
  TeamTask,
} from '../../../../packages/browser-host/src/assistant-workspace'
import './assistant-workspace-panel.css'

const labels = {
  zh: {
    chat: '对话',
    team: '助手',
    tasks: '任务',
    office: 'Office 助手',
    main: '协调者',
    builtin: '内置',
    external: '外接',
    officeHelp: '理解文档、回答问题、协调任务与汇总结果。',
    harnessHelp: '代码、数据处理与图表；使用 Office 所选模型。',
    externalHelp: '通过协作任务接收授权内容。',
    configured: '已配置 · 运行待验证',
    verified: '本会话已有完成任务',
    online: '已连接',
    offline: '不可用 / 已离线',
    empty: '暂无协作任务',
    none: '暂无已配置的 harness',
    peer: '外接助手',
    peerHelp: '连接后可在发送对象中选择，批准前不会发送文档内容。',
    closed: '当前服务未开启外接协作。',
    send: '交给它',
    recipient: '发送给',
    scope: '直接任务仅发送输入文字；如需选区、Skills 或数据分析，请交由 Office 协调授权。',
    selfModel: '由外接助手管理模型',
    cancel: '请求取消',
    details: '查看任务详情',
    summary: '结果',
    session: '内置任务仅保留在当前编辑器会话。',
    states: {
      running: '执行中',
      cancel_requested: '正在取消',
      succeeded: '已完成',
      failed: '失败',
      unknown_outcome: '结果待核对',
    },
    notices: {
      extras: '当前含有选区、附件或 Skills，请切回 Office 助手处理，或移除这些内容后直接委派。',
      busy: '上一条直接任务仍在处理中，请查看任务状态。',
      unavailable: '目标当前不可用，请检查连接或选择其他助手。',
      failed: '任务未完成或提交未获确认，草稿已保留。请先查看任务，避免重复执行。',
      sent: '已交给团队成员，进展将在对话中更新。',
      cancelFailed: '取消请求未获确认，请检查连接与任务状态。',
      length: '任务文字不能超过 16000 字符。',
    },
  },
  en: {
    chat: 'Chat',
    team: 'Assistants',
    tasks: 'Tasks',
    office: 'Office assistant',
    main: 'Coordinator',
    builtin: 'Built-in',
    external: 'External',
    officeHelp: 'Read documents, answer questions and coordinate tasks.',
    harnessHelp: 'Code, data and charts using the selected Office model.',
    externalHelp: 'Receives authorized content through collaboration tasks.',
    configured: 'Configured · Runtime not verified',
    verified: 'Completed a task in this session',
    online: 'Connected',
    offline: 'Unavailable / Offline',
    empty: 'No tasks',
    none: 'No harness configured',
    peer: 'External assistants',
    peerHelp:
      'Connected peers appear in the recipient list. Approval is required before sharing document content.',
    closed: 'External collaboration is disabled on this service.',
    send: 'Delegate',
    recipient: 'Send to',
    scope:
      'Direct tasks send only your text. Use Office to coordinate selections, skills and authorized analysis data.',
    selfModel: 'Model managed by the external assistant',
    cancel: 'Request cancellation',
    details: 'Task details',
    summary: 'Result',
    session: 'Built-in task history is limited to this editor session.',
    states: {
      running: 'Running',
      cancel_requested: 'Cancelling',
      succeeded: 'Succeeded',
      failed: 'Failed',
      unknown_outcome: 'Outcome needs review',
    },
    notices: {
      extras:
        'Selections, attachments or skills are present. Use Office, or remove them before direct delegation.',
      busy: 'A direct task is still pending. Check its status.',
      unavailable: 'The target is unavailable. Check its connection or choose another assistant.',
      failed:
        'Task or submission could not be confirmed. Your draft is retained; check the task before retrying.',
      sent: 'Sent to your teammate. Updates appear in this conversation.',
      cancelFailed: 'Cancellation could not be confirmed. Check the connection and task status.',
      length: 'Task text must not exceed 16000 characters.',
    },
  },
} as const

function useWorkspace(client: AssistantWorkspaceClient) {
  const [, update] = useState(0)
  useEffect(() => client.subscribe(() => update((value) => value + 1)), [client])
  return client.snapshot()
}

const teamLabels = {
  zh: {
    team: '文档协作团队',
    automatic: 'Office 自动协调',
    members: '团队成员',
    coordinator: '需求理解 · 文档问答 · 分工汇总',
    executor: '执行成员',
    capability: '编码 · 脚本 · 数据分析',
    externalCapability: '按授权参与任务',
    you: '你',
    assigned: '交给',
    delegated: '委派给',
    returned: '返回结果',
    viewTask: '查看任务',
    viewChat: '定位对话',
    active: '处理中',
    done: '已完成',
    attention: '需处理',
    all: '全部',
    noActive: '当前没有处理中任务',
    noDone: '还没有已完成任务',
    noAttention: '没有需要处理的任务',
    invite: '连接新成员',
    mention: '@成员',
    lead: '大部分需求交给 Office；编码和分析由 harness 执行。',
    waiting: '等待成员响应',
    queued: '排队中',
    paused: '协作已暂停',
    cancelled: '已取消',
    unknown: '结果待核对，请确认后再重试。',
    requestCancel: '请求取消',
    requestFailed: '执行未完成，请核对任务详情。',
    initiator: '发起方',
    owner: '负责人',
    noMatch: '没有匹配的成员',
    delegation: '任务交接',
    result: '结果',
    ownModel: '外接端管理模型',
  },
  en: {
    team: 'Document team',
    automatic: 'Office coordinates',
    members: 'Team members',
    coordinator: 'Understand · Read · Coordinate · Summarize',
    executor: 'Executor',
    capability: 'Code · Scripts · Data analysis',
    externalCapability: 'Works within authorized tasks',
    you: 'You',
    assigned: 'assigned to',
    delegated: 'delegated to',
    returned: 'returned a result',
    viewTask: 'View task',
    viewChat: 'View in conversation',
    active: 'In progress',
    done: 'Completed',
    attention: 'Needs attention',
    all: 'All',
    noActive: 'No tasks in progress',
    noDone: 'No completed tasks yet',
    noAttention: 'No tasks need attention',
    invite: 'Connect a teammate',
    mention: '@Mention a teammate',
    lead: 'Office handles most requests; harnesses execute code and analysis.',
    waiting: 'Waiting for teammate',
    queued: 'Queued',
    paused: 'Collaboration paused',
    cancelled: 'Cancelled',
    unknown: 'Outcome needs review. Verify before retrying.',
    requestCancel: 'Request cancellation',
    requestFailed: 'Execution did not complete. Check task details.',
    initiator: 'Requested by',
    owner: 'Owner',
    noMatch: 'No matching teammates',
    delegation: 'Handoff',
    result: 'Result',
    ownModel: 'Model managed externally',
  },
} as const
const taskStatus = (task: TeamTask, lang: 'zh' | 'en') => {
  const text = labels[lang],
    team = teamLabels[lang]
  return task.state === 'queued'
    ? team.queued
    : task.state === 'waiting_peer'
      ? team.waiting
      : task.state === 'cancelled'
        ? team.cancelled
        : text.states[task.state]
}
const taskGroup = (task: TeamTask) =>
  ['succeeded', 'cancelled'].includes(task.state)
    ? 'done'
    : ['failed', 'unknown_outcome'].includes(task.state)
      ? 'attention'
      : 'active'

export function AssistantRecipient({
  client,
  lang,
  draft = '',
  onDraftChange,
}: {
  client: AssistantWorkspaceClient
  lang: 'zh' | 'en'
  draft?: string
  onDraftChange?: (value: string) => void
}) {
  const snapshot = useWorkspace(client),
    text = labels[lang],
    team = teamLabels[lang]
  const [dismissed, setDismissed] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const mention = /^@([^\s]*)/.exec(draft),
    typed = !!mention && draft !== dismissed
  const show = typed
  const query = typed ? mention![1]!.toLocaleLowerCase() : ''
  const targets = snapshot.targets.filter(
    (target) =>
      !query ||
      target.name.toLocaleLowerCase().includes(query) ||
      (target.kind === 'office' && text.office.toLocaleLowerCase().includes(query)),
  )
  useEffect(() => {
    if (!show) return
    const close = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) {
        setDismissed(draft)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [show, draft])
  function choose(id: string) {
    client.select(id)
    setDismissed(draft)
    if (typed) onDraftChange?.(draft.replace(/^@[^\s]*\s?/, ''))
  }
  return (
    <div
      className="assistant-recipient assistant-team-recipient"
      ref={host}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setDismissed(draft)
        }
      }}
    >
      <div className="assistant-team-composer-row">
        <span className="assistant-team-scope">
          {snapshot.selected.kind === 'channel'
            ? team.ownModel
            : lang === 'zh'
              ? '当前文档'
              : 'Current document'}
        </span>
      </div>
      {show && (
        <div className="assistant-mention-menu" role="listbox" aria-label={team.members}>
          {!targets.length && <p>{team.noMatch}</p>}
          {targets.map((target) => (
            <button
              type="button"
              role="option"
              aria-selected={snapshot.selected.id === target.id}
              disabled={!target.available}
              key={target.id}
              onClick={() => choose(target.id)}
            >
              <AssistantAvatar
                name={target.kind === 'office' ? text.office : target.name}
                origin={target.origin}
              />
              <span>
                <strong>{target.kind === 'office' ? text.office : target.name}</strong>
                <small>
                  {target.kind === 'office'
                    ? team.coordinator
                    : !target.available
                      ? text.offline
                      : target.kind === 'channel'
                        ? text.external
                        : team.capability}
                </small>
              </span>
              {snapshot.selected.id === target.id && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
      {snapshot.selected.kind !== 'office' && (
        <small>{snapshot.selected.kind === 'channel' ? text.selfModel : text.scope}</small>
      )}
      {snapshot.notice && snapshot.notice !== 'sent' && (
        <p role="alert">{text.notices[snapshot.notice as keyof typeof text.notices]}</p>
      )}
    </div>
  )
}

export function handleTeamMentionKey(
  client: AssistantWorkspaceClient,
  event: KeyboardEvent,
  value: string,
  onChange: (value: string) => void,
) {
  if (
    !(event.target instanceof HTMLTextAreaElement) ||
    event.nativeEvent.isComposing ||
    event.key !== 'Enter' ||
    event.shiftKey
  )
    return
  const match = /^@([^\s]*)/.exec(value)
  if (!match) return
  event.preventDefault()
  event.stopPropagation()
  const query = match[1]!.toLocaleLowerCase(),
    target = client
      .snapshot()
      .targets.find((target) => target.available && target.name.toLocaleLowerCase().includes(query))
  if (target) {
    client.select(target.id)
    onChange(value.replace(/^@[^\s]*\s?/, ''))
  }
}

const progressLabels: Record<string, string> = {
  'Starting harness': '正在启动 harness',
  'Preparing Codex workspace': '正在准备 Codex 工作区',
  'Generating response': '正在生成回复',
  'Executing command': '正在执行命令',
  'Command finished': '命令已执行，继续处理',
  'Updating workspace files': '正在更新工作文件',
  'Collecting task results': '正在整理结果',
}
function TaskProgress({ task, lang }: { task: TeamTask; lang: 'zh' | 'en' }) {
  const pre = useRef<HTMLPreElement>(null),
    follow = useRef(true)
  const active = ['queued', 'running', 'waiting_peer', 'cancel_requested'].includes(task.state)
  useEffect(() => {
    if (pre.current && follow.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [task.progress])
  if (!active && !task.progress && !task.activity) return null
  const activity = task.activity
    ? lang === 'zh'
      ? (progressLabels[task.activity] ?? task.activity)
      : task.activity
    : lang === 'zh'
      ? '等待执行输出'
      : 'Waiting for output'
  return (
    <details
      className="assistant-task-progress"
      open={active || task.state === 'failed' || task.state === 'unknown_outcome'}
    >
      <summary>
        <span className="assistant-task-pulse" data-active={active} aria-hidden="true" />
        {lang === 'zh' ? '执行过程' : 'Execution progress'}
      </summary>
      {(active || task.activity) && (
        <p role={active ? 'status' : undefined} className="assistant-task-activity">
          {!active && (lang === 'zh' ? '最后进展：' : 'Last update: ')}
          {activity}
        </p>
      )}
      {task.progress && (
        <pre
          ref={pre}
          aria-label={lang === 'zh' ? '实时输出' : 'Live output'}
          dir="auto"
          onScroll={(event) => {
            const node = event.currentTarget
            follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32
          }}
        >
          {task.progress}
        </pre>
      )}
    </details>
  )
}

function TaskCard({
  task,
  client,
  lang,
  conversation = false,
}: {
  task: TeamTask
  client: AssistantWorkspaceClient
  lang: 'zh' | 'en'
  conversation?: boolean
}) {
  const text = labels[lang],
    team = teamLabels[lang]
  const from =
    task.initiator === 'user'
      ? team.you
      : task.initiator === 'external'
        ? text.external
        : text.office
  return (
    <article
      className={`assistant-task${conversation ? ' assistant-team-message' : ''}`}
      data-team-task={task.id}
      tabIndex={-1}
    >
      <div className="assistant-member-heading">
        <AssistantAvatar name={task.agent.name} origin={task.agent.origin} />
        <strong>{task.agent.name === 'Office' ? text.office : task.agent.name}</strong>
        <span className="assistant-source">
          {task.agent.origin === 'office' ? text.main : text[task.agent.origin]}
        </span>
        <span className="assistant-task-state" data-state={task.state}>
          {taskStatus(task, lang)}
        </span>
      </div>
      <div className="assistant-task-body">
        <div className="assistant-team-handoff">
          {from} <span aria-hidden="true">→</span>{' '}
          {task.agent.name === 'Office' ? text.office : task.agent.name}
          <span> · {team.delegation}</span>
        </div>
        <p className="assistant-task-instruction" dir="auto">
          {task.instruction}
        </p>
        <TaskProgress task={task} lang={lang} />
        {task.state === 'succeeded' && task.summary && (
          <p className="assistant-task-result" dir="auto">
            {task.summary}
          </p>
        )}
        {task.state === 'unknown_outcome' && <p role="status">{team.unknown}</p>}
        {task.state === 'failed' && <p>{team.requestFailed}</p>}
        {task.output && (
          <details>
            <summary>{team.result}</summary>
            <pre dir="auto">{task.output}</pre>
          </details>
        )}
      </div>
      <div className="assistant-task-actions">
        <button
          type="button"
          onClick={() =>
            conversation ? client.openTask(task.id) : client.openConversation(task.id)
          }
        >
          {conversation ? team.viewTask : team.viewChat}
        </button>
        {['queued', 'running', 'waiting_peer'].includes(task.state) && (
          <button type="button" onClick={() => void client.cancelTask(task.id)}>
            {team.requestCancel}
          </button>
        )}
      </div>
    </article>
  )
}

/** Preserve first-observed message order; updates replace an existing task, never append duplicates. */
export function AssistantTeamConversation({
  client,
  lang,
  children,
}: {
  client: AssistantWorkspaceClient
  lang: 'zh' | 'en'
  children: ReactNode
}) {
  const snapshot = useWorkspace(client),
    text = labels[lang],
    team = teamLabels[lang],
    host = useRef<HTMLDivElement>(null)
  const order = useRef(new Map<string, number>()),
    next = useRef(0)
  const flatten = (nodes: ReactNode): ReactNode[] =>
    Children.toArray(nodes).flatMap((node) =>
      isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment
        ? flatten(node.props.children)
        : [node],
    )
  const native = flatten(children).filter(
    (node) =>
      !(
        snapshot.teamTasks.length &&
        isValidElement<{ className?: string }>(node) &&
        node.props.className?.includes('ai-chat-empty')
      ),
  )
  const items: { id: string; node: ReactNode }[] = native.map((node, index) => ({
    id: 'office:' + (isValidElement(node) ? (node.key ?? index) : index),
    node,
  }))
  for (const task of [...snapshot.teamTasks].reverse())
    items.push({
      id: task.id,
      node: <TaskCard task={task} client={client} lang={lang} conversation />,
    })
  for (const item of items)
    if (!order.current.has(item.id)) order.current.set(item.id, next.current++)
  items.sort((a, b) => order.current.get(a.id)! - order.current.get(b.id)!)
  useEffect(() => {
    const scroller = host.current?.closest('.ai-chat')
    if (!scroller) return
    const task = Array.from(
      host.current?.querySelectorAll<HTMLElement>('[data-team-task]') ?? [],
    ).find((node) => node.dataset.teamTask === snapshot.focusedTask)
    if (task && snapshot.view === 'chat') {
      task.scrollIntoView?.({ block: 'nearest' })
      task.focus({ preventScroll: true })
    }
  }, [snapshot.focusedTask, snapshot.view])
  return (
    <div className="assistant-team-feed" ref={host}>
      {items.map((item) => {
        let node = item.node
        if (isValidElement(node)) {
          const element = node as ReactElement<{ className?: string; children?: ReactNode }>,
            className = element.props.className ?? ''
          if (className.includes('ai-msg-')) {
            const user = className.includes('ai-msg-user')
            node = (
              <div
                className={`assistant-chat-row assistant-chat-row-${user ? 'user' : 'assistant'}`}
              >
                {user ? (
                  <span className="assistant-user-avatar" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    >
                      <circle cx="12" cy="8" r="3.2" />
                      <path d="M5.5 20v-1.5a6.5 6.5 0 0 1 13 0V20" />
                    </svg>
                  </span>
                ) : (
                  <AssistantAvatar name={text.office} origin="office" />
                )}
                <div className="assistant-chat-message">
                  <div className="assistant-team-author">
                    <strong>{user ? team.you : text.office}</strong>
                    {!user && <span>{text.main}</span>}
                  </div>
                  {element}
                </div>
              </div>
            )
          }
        }
        return (
          <div key={item.id} className="assistant-team-entry">
            {node}
          </div>
        )
      })}
    </div>
  )
}

export function AssistantWorkspacePanel({
  client,
  lang,
  channelMembers,
  deliveries,
}: {
  client: AssistantWorkspaceClient
  lang: 'zh' | 'en'
  channelMembers?: ReactNode
  channelTasks?: ReactNode
  deliveries?: ReactNode
}) {
  const snapshot = useWorkspace(client),
    text = labels[lang],
    team = teamLabels[lang],
    id = useId(),
    host = useRef<HTMLElement>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'done' | 'attention'>('all')
  const view = snapshot.view,
    counts = { active: 0, done: 0, attention: 0 }
  snapshot.teamTasks.forEach((task) => counts[taskGroup(task)]++)
  useEffect(() => {
    if (view === 'tasks' && snapshot.focusedTask) setFilter('all')
  }, [view, snapshot.focusedTask])
  useEffect(() => {
    if (view === 'tasks' && snapshot.focusedTask) {
      const task = Array.from(
        host.current?.querySelectorAll<HTMLElement>('[data-team-task]') ?? [],
      ).find((node) => node.dataset.teamTask === snapshot.focusedTask)
      task?.scrollIntoView?.({ block: 'nearest' })
      task?.focus({ preventScroll: true })
    }
  }, [view, snapshot.focusedTask, filter])
  return (
    <section
      className="assistant-workspace assistant-team-workspace"
      data-view={view}
      aria-label={team.team}
      ref={host}
    >
      <div className="assistant-workspace-tabs" role="tablist" aria-label={team.team}>
        {(['chat', 'team', 'tasks'] as const).map((tab) => (
          <button
            type="button"
            role="tab"
            id={`${id}-${tab}`}
            aria-selected={view === tab}
            aria-controls={`${id}-panel`}
            key={tab}
            onClick={() => client.setView(tab)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const tabs = ['chat', 'team', 'tasks'] as const,
                index = tabs.indexOf(tab),
                next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? 2
                      : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3
              client.setView(tabs[next]!)
              document.getElementById(`${id}-${tabs[next]}`)?.focus()
            }}
            tabIndex={view === tab ? 0 : -1}
          >
            {text[tab]}
            {tab === 'team' && <span>{snapshot.targets.length}</span>}
            {tab === 'tasks' && counts.active > 0 && <span>{counts.active}</span>}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${view}`}
        className="assistant-workspace-content"
        hidden={view === 'chat'}
      >
        <div hidden={view !== 'team'}>
          <p className="assistant-section-eyebrow">{team.members}</p>
          {snapshot.targets.map((target) => {
            const assigned = snapshot.teamTasks.filter((task) =>
                target.kind === 'office'
                  ? task.agent.origin === 'office'
                  : task.targetId === target.id,
              ),
              active = assigned.filter((task) => taskGroup(task) === 'active').length
            return (
              <article
                className={`assistant-member ${target.kind === 'office' ? 'assistant-member-lead' : ''}`}
                key={target.id}
              >
                <div className="assistant-member-heading">
                  <AssistantAvatar
                    name={target.kind === 'office' ? text.office : target.name}
                    origin={target.origin}
                  />
                  <strong>{target.kind === 'office' ? text.office : target.name}</strong>
                  <span className="assistant-source">
                    {target.kind === 'office' ? text.main : text[target.origin]}
                  </span>
                  <button
                    type="button"
                    disabled={!target.available}
                    onClick={() => {
                      client.select(target.id)
                      client.setView('chat')
                    }}
                  >
                    {target.kind === 'office' ? text.chat : '@ ' + target.name}
                  </button>
                </div>
                <p>
                  {target.kind === 'office'
                    ? team.coordinator
                    : target.kind === 'harness'
                      ? team.capability
                      : team.externalCapability}
                </p>
                {target.kind !== 'office' && (
                  <div className="assistant-member-status">
                    <span>
                      {!target.available
                        ? snapshot.channel?.paused && target.kind === 'channel'
                          ? team.paused
                          : text.offline
                        : active
                          ? `${active} · ${team.active}`
                          : target.kind === 'channel'
                            ? text.online
                            : assigned.some((task) => task.state === 'succeeded')
                              ? text.verified
                              : text.configured}
                    </span>
                    <span>{team.executor}</span>
                  </div>
                )}
              </article>
            )
          })}
          <details className="assistant-team-connect">
            <summary>{team.invite}</summary>
            <p className="assistant-workspace-muted">
              {channelMembers ? text.peerHelp : text.closed}
            </p>
            {channelMembers}
          </details>
        </div>
        <div hidden={view !== 'tasks'}>
          <div className="assistant-task-filters" aria-label={text.tasks}>
            {(['all', 'active', 'done', 'attention'] as const).map((key) => (
              <button
                type="button"
                key={key}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {team[key]}
                <span>{key === 'all' ? snapshot.teamTasks.length : counts[key]}</span>
              </button>
            ))}
          </div>
          {!snapshot.teamTasks.filter((task) => filter === 'all' || taskGroup(task) === filter)
            .length && (
            <div className="assistant-team-empty">
              <strong>
                {filter === 'all'
                  ? text.empty
                  : filter === 'active'
                    ? team.noActive
                    : filter === 'done'
                      ? team.noDone
                      : team.noAttention}
              </strong>
              <p>{team.lead}</p>
            </div>
          )}
          {snapshot.teamTasks
            .filter((task) => filter === 'all' || taskGroup(task) === filter)
            .map((task) => (
              <TaskCard key={task.id} task={task} client={client} lang={lang} />
            ))}
          {deliveries}
          <p className="assistant-workspace-muted">{text.session}</p>
        </div>
      </div>
    </section>
  )
}
