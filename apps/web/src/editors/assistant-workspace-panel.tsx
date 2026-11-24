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
    builtin: '内置',
    external: '外接',
    officeHelp: '负责理解需求、处理文档并汇总执行结果。',
    harnessHelp: '处理编程、脚本与需要运行环境的分析任务。',
    externalHelp: '通过协作任务接收授权内容。',
    configured: '已配置 · 运行待验证',
    verified: '本会话已有完成任务',
    online: '已连接',
    offline: '不可用 / 已离线',
    empty: '暂无协作任务',
    none: '暂无已配置的 harness',
    peer: '外接执行器',
    peerHelp: '外接连接仅接收明确委派且获授权的任务。',
    closed: '当前未连接外接执行器。',
    send: '委派',
    recipient: '执行方式',
    selfModel: '由外接助手管理模型',
    cancel: '请求取消',
    summary: '结果',
    session: '刷新此页后可查看同一文档的近期任务。',
    states: {
      running: '执行中',
      cancel_requested: '正在取消',
      succeeded: '已完成',
      failed: '未完成',
      unknown_outcome: '结果待核对',
    },
    notices: {
      extras: '当前含有选区、附件或 Skills，请由 Office 助手协调处理。',
      busy: '上一项执行任务仍在处理中，请查看任务状态。',
      unavailable: '当前执行器不可用，请选择自动安排或检查连接。',
      failed: '任务未完成或提交未获确认，草稿已保留。请先查看任务，避免重复执行。',
      sent: '执行任务已提交，进展将在对话中更新。',
      cancelFailed: '取消请求未获确认，请检查连接与任务状态。',
      length: '任务文字不能超过 16000 字符。',
    },
  },
  en: {
    chat: 'Chat',
    team: 'Assistants',
    tasks: 'Tasks',
    office: 'Office assistant',
    builtin: 'Built-in',
    external: 'External',
    officeHelp: 'Understand requests, edit files and summarize results.',
    harnessHelp: 'Run code, scripts and analysis that needs an execution environment.',
    externalHelp: 'Receives authorized content through collaboration tasks.',
    configured: 'Configured · Runtime not verified',
    verified: 'Completed a task in this session',
    online: 'Connected',
    offline: 'Unavailable / Offline',
    empty: 'No tasks',
    none: 'No harness configured',
    peer: 'External executors',
    peerHelp: 'External connections receive only explicitly delegated and authorized tasks.',
    closed: 'No external executor is connected.',
    send: 'Delegate',
    recipient: 'Execution mode',
    selfModel: 'Model managed by the external assistant',
    cancel: 'Request cancellation',
    summary: 'Result',
    session: 'Refresh this tab to reopen recent tasks for this document.',
    states: {
      running: 'Running',
      cancel_requested: 'Cancelling',
      succeeded: 'Succeeded',
      failed: 'Failed',
      unknown_outcome: 'Outcome needs review',
    },
    notices: {
      extras: 'Selections, attachments or skills are present. Let Office coordinate this task.',
      busy: 'A task is still running. Check its status.',
      unavailable: 'This executor is unavailable. Choose automatic routing or check its connection.',
      failed:
        'Task or submission could not be confirmed. Your draft is retained; check the task before retrying.',
      sent: 'Task submitted. Updates appear in this conversation.',
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
    members: '频道成员',
    executor: '执行成员',
    capability: '编码 · 脚本 · 数据分析',
    externalCapability: '按授权参与任务',
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
    waiting: '等待成员响应',
    queued: '排队中',
    paused: '协作已暂停',
    cancelled: '已取消',
    unknown: '尚未收到可确认的结果。请先查看任务详情和最后进展，核对后再安排执行，避免重复处理。',
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
    members: 'Channel members',
    executor: 'Executor',
    capability: 'Code · Scripts · Data analysis',
    externalCapability: 'Works within authorized tasks',
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
    waiting: 'Waiting for teammate',
    queued: 'Queued',
    paused: 'Collaboration paused',
    cancelled: 'Cancelled',
    unknown: 'No confirmed result was received. Review task details and the last update before requesting another run.',
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

const progressLabels: Record<string, string> = {
  'Starting harness': '正在连接执行服务',
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
  const [hasNewOutput, setHasNewOutput] = useState(false)
  const active = ['queued', 'running', 'waiting_peer', 'cancel_requested'].includes(task.state)
  const initiallyOpen = useRef(active)
  useEffect(() => {
    if (!pre.current) return
    if (follow.current) pre.current.scrollTop = pre.current.scrollHeight
    else setHasNewOutput(true)
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
    <div className="assistant-task-progress">
      {(active || task.activity) && (
        <p role={active ? 'status' : undefined} className="assistant-task-activity">
          <span className="assistant-task-pulse" data-active={active} aria-hidden="true" />
          {!active && (lang === 'zh' ? '最后进展：' : 'Last update: ')}
          {activity}
        </p>
      )}
      {task.progress && <details className="assistant-task-log" open={initiallyOpen.current} onToggle={(event) => {
        if (event.currentTarget.open && follow.current && pre.current)
          pre.current.scrollTop = pre.current.scrollHeight
      }}>
        <summary>{lang === 'zh' ? '执行记录' : 'Execution log'}</summary>
        <pre
          ref={pre}
          aria-label={lang === 'zh' ? '实时输出' : 'Live output'}
          dir="auto"
          onScroll={(event) => {
            const node = event.currentTarget
            follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32
            if (follow.current) setHasNewOutput(false)
          }}
        >
          {task.progress}
        </pre>
      {hasNewOutput && <button type="button" className="assistant-task-latest" onClick={() => {follow.current=true;setHasNewOutput(false);if(pre.current)pre.current.scrollTop=pre.current.scrollHeight}}>{lang === 'zh' ? '回到最新' : 'Back to latest'}</button>}
      </details>}
    </div>
  )
}

function taskFailureHint(task: TeamTask, lang: 'zh' | 'en') {
  const failure = task.failure ?? ''
  if (/HTTP 401|Invalid CSRF proof/.test(failure)) return lang === 'zh' ? '登录状态需要更新。请先保存文档，再重新登录。' : 'Your session needs updating. Save your document before signing in again.'
  if (/HTTP 403/.test(failure)) return lang === 'zh' ? '执行请求被拒绝，请核对账号权限。' : 'The execution request was denied. Check your account permissions.'
  if (/HTTP 429|agents are busy/.test(failure)) return lang === 'zh' ? '执行服务繁忙，请稍后再通过 Office 助手安排任务。' : 'The execution service is busy. Ask Office to arrange the task later.'
  if (failure === 'Coding agent unavailable') return lang === 'zh' ? '所选执行器当前不可用。' : 'The selected executor is unavailable.'
  return lang === 'zh' ? '这项任务未完成。可展开任务详情查看错误信息，Office 助手仍可继续处理其他请求。' : 'This task did not complete. Open task details for diagnostics; Office can continue handling other requests.'
}

function TaskMessage({
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
  const title = task.instruction.trim().split(/\r?\n/).find(Boolean)?.replace(/^任务[：:]\s*/, '') ?? (lang === 'zh' ? '执行任务' : 'Execution task')
  const attention = task.state === 'failed' || task.state === 'unknown_outcome'
  const executor = task.kind === 'channel' ? text.external : task.agent.origin === 'builtin' ? text.builtin : text.external
  return (
    <div
      className="assistant-chat-row assistant-chat-row-assistant assistant-task-message"
      data-team-task={task.id}
      tabIndex={-1}
    >
      <AssistantAvatar id={task.kind === 'harness' ? task.targetId.slice('harness:'.length) : undefined} name={task.agent.name} origin={task.agent.origin} />
      <div className="assistant-chat-message">
        <div className="assistant-team-author">
          <strong dir="auto">{task.agent.name}</strong>
          <span>{executor}</span>
          <span className="assistant-task-state" data-state={task.state}>
            {taskStatus(task, lang)}
          </span>
        </div>
        <div className="ai-msg ai-msg-assistant assistant-execution-message">
          <p className="assistant-task-title" dir="auto">{title.length > 120 ? title.slice(0, 120) + '…' : title}</p>
          {task.savedRevision && <p>后台读取 · 已保存版本 <code>{task.savedRevision}</code></p>}
          {task.state === 'succeeded' && task.summary && (
            <p className="assistant-task-result" dir="auto">{task.summary}</p>
          )}
          {task.state === 'unknown_outcome' && <p role="status">{team.unknown}</p>}
          {task.state === 'failed' && <p className="assistant-task-notice">{taskFailureHint(task, lang)}</p>}
          {task.state === 'succeeded' && task.output && (
            <details className="assistant-task-output">
              <summary>{lang === 'zh' ? '完整结果' : 'Full result'}</summary>
              <pre dir="auto">{task.output}</pre>
            </details>
          )}
          <TaskProgress task={task} lang={lang} />
          <details className="assistant-task-details">
            <summary>{lang === 'zh' ? '任务详情' : 'Task details'}</summary>
            <p className="assistant-task-detail-label">{lang === 'zh' ? '原始要求' : 'Original request'}</p>
            <p className="assistant-task-instruction" dir="auto">{task.instruction}</p>
            {attention && task.failure && <div className="assistant-task-failure">
              <p className="assistant-task-detail-label">{lang === 'zh' ? '错误信息' : 'Error details'}</p>
              <pre dir="auto">{task.failure}</pre>
            </div>}
            {attention && !task.failure && task.summary && <p dir="auto">{task.summary}</p>}
            <p className="assistant-task-detail-label">{lang === 'zh' ? '任务编号' : 'Task ID'}: <code>{task.executionId}</code></p>
          </details>
          {(!conversation || attention || ['queued', 'running', 'waiting_peer'].includes(task.state)) && (
            <div className="ai-msg-toolbar assistant-task-actions">
              {!conversation && <button type="button" onClick={() => client.openConversation(task.id)}>{team.viewChat}</button>}
              {['queued', 'running', 'waiting_peer'].includes(task.state) && (
                <button type="button" onClick={() => void client.cancelTask(task.id)}>{team.requestCancel}</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Preserve first-observed message order; updates replace an existing task, never append duplicates. */
export function AssistantTeamConversation({
  client,
  lang,
  accountName,
  children,
}: {
  client: AssistantWorkspaceClient
  lang: 'zh' | 'en'
  accountName?: string
  children: ReactNode
}) {
  const snapshot = useWorkspace(client),
    text = labels[lang],
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
        snapshot.conversationTasks.length &&
        isValidElement<{ className?: string }>(node) &&
        node.props.className?.includes('ai-chat-empty')
      ),
  )
  const items: { id: string; node: ReactNode }[] = native.map((node, index) => ({
    id: 'office:' + (isValidElement(node) ? (node.key ?? index) : index),
    node,
  }))
  for (const task of [...snapshot.conversationTasks].reverse())
    items.push({
      id: task.id,
      node: <TaskMessage task={task} client={client} lang={lang} conversation />,
    })
  for (const item of items)
    if (!order.current.has(item.id)) order.current.set(item.id, next.current++)
  items.sort((a, b) => order.current.get(a.id)! - order.current.get(b.id)!)
  // Reveal a task once per "view in conversation" request; returning to the
  // chat tab later must not pull focus off the tab or composer.
  const handledRequest = useRef(0)
  const request = snapshot.focusRequest
  useEffect(() => {
    if (!request || request.view !== 'chat' || request.id === handledRequest.current || snapshot.view !== 'chat') return
    const scroller = host.current?.closest('.ai-chat')
    if (!scroller) return
    const task = Array.from(
      host.current?.querySelectorAll<HTMLElement>('[data-team-task]') ?? [],
    ).find((node) => node.dataset.teamTask === request.task)
    if (!task) return
    handledRequest.current = request.id
    task.scrollIntoView?.({ block: 'nearest' })
    task.focus({ preventScroll: true })
  }, [request, snapshot.view, items.length])
  return (
    <div className="assistant-team-feed" ref={host}>
      {items.map((item) => {
        let node = item.node
        if (isValidElement(node)) {
          const element = node as ReactElement<{ className?: string; children?: ReactNode; 'data-sender'?:string }>,
            className = element.props.className ?? ''
          if (className.includes('ai-msg-')) {
            const user = className.includes('ai-msg-user'),dsh=user&&element.props['data-sender']==='dsh'
            node = (
              <div
                className={`assistant-chat-row assistant-chat-row-${user ? 'user' : 'assistant'}`}
              >
                {dsh ? <AssistantAvatar name="DSH" id="dsh" origin="external"/> : user ? (
                  <span className="assistant-user-avatar" role="img" aria-label={accountName || (lang === 'zh' ? '用户' : 'User')} title={accountName || undefined}>
                    {Array.from(accountName || (lang === 'zh' ? '用' : 'U'))[0]?.toUpperCase()}
                  </span>
                ) : (
                  <AssistantAvatar name={text.office} origin="office" />
                )}
                <div className="assistant-chat-message">
                  {(dsh||!user) && <div className="assistant-team-author"><strong>{dsh?'DSH':text.office}</strong></div>}
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
  channelConnection,
  deliveries,
}: {
  client: AssistantWorkspaceClient
  lang: 'zh' | 'en'
  channelConnection?: ReactNode
  deliveries?: ReactNode
}) {
  const snapshot = useWorkspace(client),
    text = labels[lang],
    team = teamLabels[lang],
    id = useId(),
    host = useRef<HTMLElement>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'done' | 'attention'>('all')
  const tabs = ['chat', 'tasks'] as const
  const view = snapshot.view,
    counts = { active: 0, done: 0, attention: 0 }
  snapshot.teamTasks.forEach((task) => counts[taskGroup(task)]++)
  // Same one-shot rule for "open task": a later tab switch or filter change
  // must not move keyboard focus from the tab list to an old task card.
  const handledRequest = useRef(0)
  const request = snapshot.focusRequest
  const pendingRequest = request && request.view === 'tasks' && request.id !== handledRequest.current ? request : null
  useEffect(() => {
    if (view === 'tasks' && pendingRequest) setFilter('all')
  }, [view, pendingRequest])
  useEffect(() => {
    if (view !== 'tasks' || !pendingRequest) return
    const task = Array.from(
      host.current?.querySelectorAll<HTMLElement>('[data-team-task]') ?? [],
    ).find((node) => node.dataset.teamTask === pendingRequest.task)
    if (!task) return
    handledRequest.current = pendingRequest.id
    task.scrollIntoView?.({ block: 'nearest' })
    task.focus({ preventScroll: true })
  }, [view, pendingRequest, filter, snapshot.teamTasks.length])
  return (
    <section
      className="assistant-workspace assistant-team-workspace"
      data-view={view}
      aria-label={text.office}
      ref={host}
    >
      <div className="assistant-workspace-tabs" role="tablist" aria-label={text.office}>
        {tabs.map((tab) => (
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
              const index = tabs.indexOf(tab),
                next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
              client.setView(tabs[next]!)
              document.getElementById(`${id}-${tabs[next]}`)?.focus()
            }}
            tabIndex={view === tab ? 0 : -1}
          >
            {text[tab]}
            {tab === 'tasks' && counts.active > 0 && <span>{counts.active}</span>}
          </button>
        ))}
      </div>
      {channelConnection}
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${view}`}
        className="assistant-workspace-content"
        hidden={view === 'chat'}
      >
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
            </div>
          )}
          {snapshot.teamTasks
            .filter((task) => filter === 'all' || taskGroup(task) === filter)
            .map((task) => (
              <TaskMessage key={task.id} task={task} client={client} lang={lang} />
            ))}
          <p className="assistant-workspace-muted">{text.session}</p>
          {deliveries}
        </div>
      </div>
    </section>
  )
}
