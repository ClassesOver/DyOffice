// QA-only DOM shell. Dependency injection is local to tests, never a window hook.
export function installControlledQa({
  main,
  fileId,
  createController,
  getCsrfToken,
  getStorage = () => window.localStorage,
}: {
  main: HTMLElement
  fileId: string
  createController: (options: any) => any
  getCsrfToken: () => Promise<string>
  getStorage?: () => Pick<Storage, 'getItem' | 'setItem'>
}) {
  function node(tag: string, text = '') {
    const n = document.createElement(tag)
    n.textContent = text
    return n
  }
  const status = node('p'),
    list = node('ol'),
    selection = document.createElement('select'),
    replacement = document.createElement('textarea'),
    approval = document.createElement('input'),
    details = node('pre'),
    recovery = document.createElement('a')
  status.setAttribute('role', 'status')
  selection.setAttribute('aria-label', '选择段落')
  replacement.setAttribute('aria-label', '整段替换内容')
  replacement.rows = 4
  approval.type = 'checkbox'
  const label = node('label', '我确认上述精确候选、文件与基线，仅审批这一次修改。')
  label.prepend(approval)
  const propose = document.createElement('button'),
    approve = document.createElement('button'),
    apply = document.createElement('button'),
    save = document.createElement('button')
  propose.textContent = '创建提案（不执行）'
  approve.textContent = '明确审批'
  apply.textContent = '应用已审批修改'
  save.textContent = '保存并核验收据'
  recovery.textContent = '前往独立恢复页（不自动重放）'
  recovery.hidden = true
  main.append(
    status,
    list,
    node('h2', '整段替换候选'),
    selection,
    replacement,
    propose,
    details,
    label,
    approve,
    apply,
    save,
    recovery,
  )
  let controller: any | undefined,
    unsubscribe: (() => void) | undefined,
    disposed = false
  let epoch = 0
  let lastPhase = '',
    busy = false,
    snapshot: any
  function render(s: any) {
    snapshot = s
    status.textContent = `${s.phase}: ${s.message ?? ''}`
    list.replaceChildren(...s.paragraphs.map((p: string) => node('li', p)))
    if (selection.options.length !== s.paragraphs.length) {
      selection.replaceChildren(
        ...s.paragraphs.map((_p: string, i: number) => {
          const o = document.createElement('option')
          o.value = String(i)
          o.textContent = `第 ${i + 1} 段`
          return o
        }),
      )
    }
    if (lastPhase !== s.phase) approval.checked = false
    lastPhase = s.phase
    const editable = s.phase === 'ready' && !busy
    selection.disabled = replacement.disabled = propose.disabled = !editable
    approval.disabled = s.phase !== 'pending_approval' || busy
    approve.disabled = s.phase !== 'pending_approval' || !approval.checked || busy
    apply.disabled = s.phase !== 'approved' || busy
    save.disabled = s.phase !== 'applied_uncommitted' || busy
    details.textContent = JSON.stringify(
      {
        fileId: s.fileId,
        base: s.base,
        candidate: s.candidate,
        proposal: s.proposal,
        receipt: s.receipt,
      },
      null,
      2,
    )
    const opaque =
      s.recovery &&
      [s.recovery.fileId, s.recovery.commandId].every(
        (v: unknown) =>
          typeof v === 'string' &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v),
      )
    recovery.hidden = !(['blocked', 'recovery_required'].includes(s.phase) && opaque)
    if (!recovery.hidden)
      recovery.textContent =
        '查看旧命令恢复状态（不重放）：' + s.recovery.fileId + ' / ' + s.recovery.commandId
    if (!recovery.hidden)
      recovery.href =
        '/qa/controlled/recovery?fileId=' +
        encodeURIComponent(s.recovery.fileId) +
        '&commandId=' +
        encodeURIComponent(s.recovery.commandId)
  }
  async function act(fn: (current: any) => Promise<void>) {
    if (busy || disposed || !controller) return
    const mine = epoch,
      current = controller
    busy = true
    if (snapshot) render(snapshot)
    let failure: unknown
    try {
      await fn(current)
    } catch (error) {
      failure = error
    } finally {
      if (mine === epoch && !disposed) {
        busy = false
        if (snapshot) render(snapshot)
        if (failure && !['recovery_required', 'blocked', 'committed'].includes(snapshot?.phase))
          status.textContent = failure instanceof Error ? failure.message : '操作失败；不自动重试'
      }
    }
  }
  approval.addEventListener('change', () => {
    if (snapshot) render(snapshot)
  })
  propose.onclick = () =>
    void act(async (current) => {
      current.setCandidate(Number(selection.value), replacement.value)
      await current.propose()
    })
  approve.onclick = () => {
    if (approval.checked) void act((current) => current.approve())
  }
  apply.onclick = () => void act((current) => current.apply())
  save.onclick = () => void act((current) => current.save())
  function start() {
    disposed = false
    busy = false
    const mine = ++epoch
    try {
      const pointerStorage = getStorage()
      // Access failure fails before creating a network-capable controller.
      pointerStorage.getItem('dyoffice.t14.controlled.v1')
      const current = createController({ fileId, pointerStorage, getCsrfToken })
      controller = current
      unsubscribe = current.subscribe(() => {
        if (!disposed && mine === epoch) render(current.snapshot())
      })
      render(current.snapshot())
      void act((current) => current.open())
    } catch (error) {
      controller?.dispose()
      controller = undefined
      render({
        phase: 'blocked',
        message:
          '持久恢复存储不可用，禁止编辑：' + (error instanceof Error ? error.message : '未知错误'),
        fileId,
        paragraphs: [],
      })
    }
  }
  window.addEventListener('pagehide', () => {
    ++epoch
    disposed = true
    unsubscribe?.()
    controller?.dispose()
    controller = undefined
    busy = false
  })
  window.addEventListener('pageshow', () => {
    if (disposed) start()
  })
  start()
}
