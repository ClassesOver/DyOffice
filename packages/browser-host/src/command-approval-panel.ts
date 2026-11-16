import { sameCommandJson } from './command-equality.ts'
import type { CommandEnvelope } from '../../web-contracts/src/tools.ts'
interface Proposal {
  state: string
  digest: string
  envelope: CommandEnvelope
}
/** Isolated opt-in UI. Provider transports receive no handle to its approve or
 * execute callbacks. Text-only rendering; no HTML from model or tool arguments. */
export function mountCommandApprovalPanel(
  root: HTMLElement,
  {
    proposal,
    approve,
    execute,
    cancel,
  }: {
    proposal: Proposal
    approve: (envelope: CommandEnvelope, digest: string) => Promise<Proposal>
    execute: (envelope: CommandEnvelope, digest: string) => Promise<{ status: string }>
    cancel: (envelope: CommandEnvelope) => Promise<Proposal>
  },
) {
  const original = structuredClone(proposal),
    doc = root.ownerDocument
  if (original.state !== 'pending_approval') throw Error('A fresh server proposal is required')
  let state = 'pending_approval',
    reviewed = false,
    busy = false,
    disposed = false
  const section = doc.createElement('section'),
    heading = doc.createElement('h3'),
    preview = doc.createElement('pre'),
    status = doc.createElement('p'),
    label = doc.createElement('label'),
    check = doc.createElement('input')
  heading.textContent = '审核文档修改'
  preview.textContent = JSON.stringify(
    {
      file: original.envelope.fileId,
      baseRevision: original.envelope.baseRevision,
      leaseEpoch: original.envelope.leaseEpoch,
      tool: original.envelope.payload.toolName,
      arguments: original.envelope.payload.arguments,
    },
    null,
    2,
  )
  check.type = 'checkbox'
  label.append(check, doc.createTextNode('我已核对工具、参数和目标版本'))
  status.setAttribute('role', 'status')
  const button = (action: string, text: string) => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.dataset.action = action
    b.textContent = text
    return b
  }
  const yes = button('approve', '批准此修改'),
    run = button('execute', '执行已批准修改'),
    no = button('cancel', '取消')
  section.append(heading, preview, label, yes, run, no, status)
  root.replaceChildren(section)
  const labels: Record<string, string> = {
    pending_approval: '等待审批',
    approved: '已批准，尚未执行',
    applied_uncommitted: '已应用，未保存',
    committed: '已保存',
    cancelled: '已取消',
    conflict: '冲突，请重新核对',
    unknown_outcome: '结果未知，请核对日志，勿重复执行',
  }
  function render() {
    if (disposed) return
    status.textContent = busy ? '处理中' : (labels[state] ?? labels.unknown_outcome)
    check.disabled = busy || state !== 'pending_approval'
    yes.disabled = busy || !reviewed || state !== 'pending_approval'
    run.disabled = busy || state !== 'approved'
    no.disabled = busy || !['pending_approval', 'approved'].includes(state)
  }
  function valid(p: Proposal) {
    return p.digest === original.digest && sameCommandJson(p.envelope, original.envelope)
  }
  async function act(kind: 'approve' | 'execute' | 'cancel') {
    if (disposed || busy) return
    if (
      (kind === 'approve' && (!reviewed || state !== 'pending_approval')) ||
      (kind === 'execute' && state !== 'approved') ||
      (kind === 'cancel' && !['pending_approval', 'approved'].includes(state))
    )
      return
    busy = true
    render()
    try {
      const e = structuredClone(original.envelope)
      if (kind === 'execute') {
        const result = await execute(e, original.digest)
        state = ['applied_uncommitted', 'conflict', 'unknown_outcome', 'cancelled'].includes(
          result.status,
        )
          ? result.status
          : 'unknown_outcome'
      } else {
        const p = await (kind === 'approve' ? approve(e, original.digest) : cancel(e))
        state =
          valid(p) && p.state === (kind === 'approve' ? 'approved' : 'cancelled')
            ? p.state
            : 'unknown_outcome'
      }
    } catch {
      state = 'unknown_outcome'
    } finally {
      busy = false
      render()
    }
  }
  check.addEventListener('change', () => {
    reviewed = check.checked
    render()
  })
  yes.addEventListener('click', () => void act('approve'))
  run.addEventListener('click', () => void act('execute'))
  no.addEventListener('click', () => void act('cancel'))
  render()
  return {
    dispose() {
      disposed = true
      section.remove()
    },
  }
}
