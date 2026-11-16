import { isRevisionRef, type RevisionRef } from '../../web-contracts/src/api.ts'
export interface RecoveryResult {
  fileId: string
  commandId: string
  digest: string
  state: string
  revision?: RevisionRef
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const terminal = ['committed', 'cancelled', 'abandoned_uncommitted']
const states = [
  'pending_approval',
  'approved',
  'unknown_outcome',
  'applied_uncommitted',
  ...terminal,
]
function identity(fileId: string, commandId: string) {
  if (!uuid.test(fileId) || !uuid.test(commandId)) throw Error('Invalid recovery identity')
}
function result(
  value: unknown,
  fileId: string,
  commandId: string,
  digest?: string,
): RecoveryResult {
  const r = value as RecoveryResult
  if (
    !r ||
    typeof r !== 'object' ||
    Array.isArray(r) ||
    r.fileId !== fileId ||
    r.commandId !== commandId ||
    typeof r.digest !== 'string' ||
    !hash.test(r.digest) ||
    (digest !== undefined && r.digest !== digest) ||
    !states.includes(r.state)
  )
    throw Error('Invalid recovery response')
  const expected =
    r.state === 'committed'
      ? ['commandId', 'digest', 'fileId', 'revision', 'state']
      : ['commandId', 'digest', 'fileId', 'state']
  if (Object.keys(r).sort().join() !== expected.join()) throw Error('Invalid recovery projection')
  if (
    r.state === 'committed' &&
    (!isRevisionRef(r.revision) ||
      r.revision.fileId !== fileId ||
      Object.keys(r.revision).sort().join() !== 'fileId,revision,sha256,size')
  )
    throw Error('Invalid recovery receipt')
  return structuredClone(r)
}
/** Fixed same-origin requests; no editor identity, execution, retries or takeover. */
export function createHttpCommandRecoveryClient({
  getCsrfToken,
  fetchImpl = fetch,
}: {
  getCsrfToken: () => Promise<string>
  fetchImpl?: typeof fetch
}) {
  let disposed = false
  const pending = new Set<AbortController>()
  async function request(
    action: 'lookup' | 'abandon',
    fileId: string,
    commandId: string,
    observedDigest?: string,
  ) {
    identity(fileId, commandId)
    if (disposed) throw Error('Recovery client disposed')
    if (action === 'abandon' && (!observedDigest || !hash.test(observedDigest)))
      throw Error('Invalid recovery digest')
    const ctrl = new AbortController()
    pending.add(ctrl)
    try {
      const csrf = await getCsrfToken()
      if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf))
        throw Error('Invalid CSRF token')
      if (disposed || ctrl.signal.aborted) throw Error('Recovery request stopped')
      const response = await fetchImpl('/api/v1/command-recovery/' + action, {
        method: 'POST',
        mode: 'same-origin',
        redirect: 'error',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          fileId,
          commandId,
          ...(action === 'abandon' ? { observedDigest } : {}),
        }),
      })
      if (disposed || ctrl.signal.aborted) throw Error('Recovery request stopped')
      if (!response.ok) {
        const e = Object.assign(
          Error(
            response.status === 401
              ? '会话失效，请重新登录；新会话不能自动恢复旧命令'
              : response.status === 404
                ? '当前会话无法恢复该命令'
                : '结果未确认，请仅查询状态',
          ),
          { statusCode: response.status },
        )
        throw e
      }
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw Error('Invalid recovery content type')
      let text = ''
      const reader = response.body?.getReader()
      if (!reader) throw Error('Missing recovery response')
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let size = 0
        for (;;) {
          const chunk = await reader.read()
          if (disposed || ctrl.signal.aborted) throw Error('Recovery request stopped')
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 8192) throw Error('Recovery response too large')
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      if (disposed || ctrl.signal.aborted) throw Error('Recovery request stopped')
      const parsed = result(JSON.parse(text), fileId, commandId, observedDigest)
      if (action === 'abandon' && !terminal.includes(parsed.state))
        throw Error('Unconfirmed abandonment')
      return parsed
    } finally {
      pending.delete(ctrl)
    }
  }
  return {
    lookup: (f: string, c: string) => request('lookup', f, c),
    abandon: (f: string, c: string, d: string) => request('abandon', f, c, d),
    cancelPending() {
      for (const c of pending) c.abort()
    },
    dispose() {
      disposed = true
      for (const c of pending) c.abort()
    },
  }
}
/** Mount only in a fresh controlled page, never in the native App's realm. */
export function mountCommandRecoveryPanel(
  root: HTMLElement,
  {
    fileId,
    commandId,
    client,
  }: {
    fileId: string
    commandId: string
    client: {
      lookup: (f: string, c: string) => Promise<RecoveryResult>
      abandon: (f: string, c: string, d: string) => Promise<RecoveryResult>
      cancelPending?: () => void
    }
  },
) {
  identity(fileId, commandId)
  const doc = root.ownerDocument,
    section = doc.createElement('section'),
    heading = doc.createElement('h1'),
    warning = doc.createElement('p'),
    status = doc.createElement('p'),
    details = doc.createElement('pre'),
    label = doc.createElement('label'),
    check = doc.createElement('input')
  heading.textContent = '文档命令恢复（受控实验）'
  warning.textContent =
    '已发送的请求可能已生效。放弃仅禁止该命令后续保存，不等于撤销本地修改或撤回已提交版本。此页面不会重放修改、恢复旧编辑器或抢占租约。'
  status.setAttribute('role', 'status')
  check.type = 'checkbox'
  label.append(check, doc.createTextNode('我理解放弃不是撤销，并明确放弃该命令后续保存'))
  const button = (action: string, text: string) => {
      const b = doc.createElement('button')
      b.type = 'button'
      b.dataset.action = action
      b.textContent = text
      return b
    },
    query = button('lookup', '查询状态'),
    abandon = button('abandon', '放弃该命令后续保存'),
    stop = button('stop', '停止等待（不撤回请求）')
  section.append(heading, warning, status, details, label, query, abandon, stop)
  root.replaceChildren(section)
  let disposed = false,
    busy = false,
    version = 0,
    displayed: RecoveryResult | undefined,
    message = '准备查询状态'
  const labels: Record<string, string> = {
    pending_approval: '等待审批，刷新后不会自动审批',
    approved: '已批准，但不会自动执行',
    unknown_outcome: '本地执行结果未知，勿重复操作',
    applied_uncommitted: '修改可能已应用，但未确认持久保存',
    committed: '已验证保存收据（可能不是当前最新版本）',
    cancelled: '命令已取消，不代表撤销本地修改',
    abandoned_uncommitted: '已禁止该命令后续保存；未撤销本地修改',
  }
  function render() {
    if (disposed) return
    status.textContent = busy ? '处理中，已发送请求可能继续完成' : message
    details.textContent = displayed
      ? JSON.stringify(displayed, null, 2)
      : `文件 ${fileId}\n命令 ${commandId}`
    query.disabled = busy
    check.disabled = busy || !displayed || terminal.includes(displayed.state)
    abandon.disabled = check.disabled || !check.checked
    stop.disabled = !busy
  }
  async function act(kind: 'lookup' | 'abandon') {
    if (
      disposed ||
      busy ||
      (kind === 'abandon' && (!displayed || !check.checked || terminal.includes(displayed.state)))
    )
      return
    const ticket = ++version,
      digest = displayed?.digest
    busy = true
    check.checked = false
    render()
    try {
      const r =
        kind === 'lookup'
          ? await client.lookup(fileId, commandId)
          : await client.abandon(fileId, commandId, digest!)
      if (disposed || ticket !== version) return
      displayed = result(r, fileId, commandId, kind === 'abandon' ? digest : undefined)
      if (kind === 'abandon' && !terminal.includes(displayed.state))
        throw Error('Unconfirmed abandonment')
      message = labels[displayed.state]
    } catch (e) {
      if (disposed || ticket !== version) return
      displayed = undefined
      message =
        (e as { statusCode?: number })?.statusCode === 404
          ? '当前会话无法恢复该命令；新登录会话不能恢复旧命令'
          : (e as { statusCode?: number })?.statusCode === 401
            ? '会话已失效；重新登录不会恢复旧命令权限'
            : '结果未确认。已发送请求可能已生效，请仅查询状态，勿重复提交。'
    } finally {
      if (!disposed && ticket === version) {
        busy = false
        render()
      }
    }
  }
  check.addEventListener('change', render)
  query.addEventListener('click', () => void act('lookup'))
  abandon.addEventListener('click', () => void act('abandon'))
  stop.addEventListener('click', () => {
    if (!busy || disposed) return
    version++
    client.cancelPending?.()
    busy = false
    displayed = undefined
    check.checked = false
    message = '已停止等待，但没有撤回已发送请求。结果未确认，请查询状态。'
    render()
  })
  render()
  void act('lookup')
  return {
    dispose() {
      disposed = true
      version++
      client.cancelPending?.()
      root.replaceChildren()
    },
  }
}
/** BFCache pages retain JavaScript objects: never reuse disposed clients/panels. */
export function installCommandRecoveryPage(
  root: HTMLElement,
  {
    fileId,
    commandId,
    createClient,
  }: {
    fileId: string
    commandId: string
    createClient: () => ReturnType<typeof createHttpCommandRecoveryClient>
  },
) {
  const win = root.ownerDocument.defaultView
  if (!win) throw Error('A live document is required')
  let active:
      | {
          client: ReturnType<typeof createHttpCommandRecoveryClient>
          panel: ReturnType<typeof mountCommandRecoveryPanel>
        }
      | undefined,
    closed = false
  function mount() {
    if (closed || active) return
    const client = createClient()
    active = { client, panel: mountCommandRecoveryPanel(root, { fileId, commandId, client }) }
  }
  function hide() {
    if (!active) return
    active.panel.dispose()
    active.client.dispose()
    active = undefined
  }
  win.addEventListener('pagehide', hide)
  win.addEventListener('pageshow', mount)
  mount()
  return {
    dispose() {
      closed = true
      hide()
      win!.removeEventListener('pagehide', hide)
      win!.removeEventListener('pageshow', mount)
    },
  }
}
