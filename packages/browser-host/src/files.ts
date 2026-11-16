import type { RevisionRef } from '../../web-contracts/src/api.ts'

export interface DocsBlock {
  docxIndex?: number
  type: string
  text: string
  editable: boolean
}

export interface DocsEditorHost {
  acquireLease(fileId: string): Promise<{ leaseEpoch: number }>
  readDocx(fileId: string): Promise<{ file: RevisionRef; leaseEpoch: number; blocks: DocsBlock[] }>
  commitDocx(fileId: string, input: {
    baseRevision: string
    leaseEpoch: number
    idempotencyKey: string
    blocks: Array<{ docxIndex?: number; text?: string }>
  }): Promise<RevisionRef>
  renewLease?(fileId: string, leaseEpoch: number): Promise<{ leaseEpoch: number }>
}

export interface DocsEditorState {
  fileId: string
  revision: string
  dirty: boolean
  blocks: DocsBlock[]
}

export interface DocsEditorHandle {
  getState(): DocsEditorState
  updateText(index: number, text: string): void
  undo(): boolean
  save(): Promise<{ ok: boolean; conflict?: boolean; revision?: string }>
  destroy(): void
}

function payload(blocks: DocsBlock[]): Array<{ docxIndex?: number; text?: string }> {
  return blocks.map((block) => {
    if (block.docxIndex === undefined) return { text: block.text }
    if (block.editable) return { docxIndex: block.docxIndex, text: block.text }
    return { docxIndex: block.docxIndex }
  })
}

/**
 * Browser DOCX surface. Bytes stay on the host: this view edits the projection
 * and commits through the caller's save API. It does not mount the desktop ribbon.
 */
function sameText(left: DocsBlock[], right: DocsBlock[]): boolean {
  return left.length === right.length && left.every((block, index) => block.text === right[index]?.text)
}

function keepNewerEdits(server: DocsBlock[], submitted: DocsBlock[], current: DocsBlock[]): DocsBlock[] {
  return server.map((block, index) => {
    const before = submitted[index]
    const after = current[index]
    if (before && after && before.text !== after.text && block.editable) return { ...block, text: after.text }
    return { ...block }
  })
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
}

export async function mountDocsEditor(host: DocsEditorHost, element: HTMLElement, fileId: string, options: { renewEveryMs?: number } = {}): Promise<DocsEditorHandle> {
  const document = element.ownerDocument
  if (!document) throw new Error('Editor element has no document')
  let leaseEpoch = (await host.acquireLease(fileId)).leaseEpoch
  let opened = await host.readDocx(fileId)
  let revision = opened.file.revision
  let blocks = opened.blocks.map((block) => ({ ...block }))
  let dirty = false
  const undoStack: string[][] = []
  let closed = false
  let saving = false

  function snapshot(): DocsEditorState {
    return { fileId, revision, dirty, blocks: blocks.map((block) => ({ ...block })) }
  }

  function draw(): void {
    const root = document.createElement('div')
    root.dataset.docsEditor = 'mounted'
    const status = document.createElement('p')
    status.dataset.status = dirty ? 'dirty' : 'saved'
    status.textContent = dirty ? '有未保存的修改。' : '已保存。'
    root.append(status)
    blocks.forEach((block, index) => {
      if (block.editable) {
        const field = document.createElement('textarea')
        field.dataset.index = String(index)
        field.value = block.text
        field.addEventListener('input', () => { updateText(index, field.value) })
        root.append(field)
        return
      }
      const preserved = document.createElement('p')
      preserved.dataset.preserved = block.type
      preserved.textContent = block.text
      root.append(preserved)
    })
    element.replaceChildren(root)
  }

  function updateText(index: number, text: string): void {
    if (closed) return
    const block = blocks[index]
    if (!block?.editable || block.text === text) return
    undoStack.push(blocks.map((item) => item.text))
    blocks = blocks.map((item, itemIndex) => itemIndex === index ? { ...item, text } : item)
    dirty = true
    const field = element.querySelector(`textarea[data-index="${index}"]`)
    if (field instanceof element.ownerDocument.defaultView!.HTMLTextAreaElement && field.value !== text) field.value = text
    const status = element.querySelector('[data-status]')
    if (status) {
      status.setAttribute('data-status', 'dirty')
      status.textContent = '有未保存的修改。'
    }
  }

  function undo(): boolean {
    const previous = undoStack.pop()
    if (!previous) return false
    blocks = blocks.map((block, index) => ({ ...block, text: previous[index] ?? block.text }))
    dirty = true
    draw()
    return true
  }

  async function ensureLease(): Promise<void> {
    if (!host.renewLease) return
    try {
      leaseEpoch = (await host.renewLease(fileId, leaseEpoch)).leaseEpoch
    } catch (error) {
      if (errorCode(error) !== 'CONFLICT') throw error
      leaseEpoch = (await host.acquireLease(fileId)).leaseEpoch
    }
  }

  async function renewQuietly(): Promise<void> {
    if (closed || saving || !host.renewLease) return
    try {
      const next = await host.renewLease(fileId, leaseEpoch)
      if (!closed) leaseEpoch = next.leaseEpoch
    } catch { /* The next save reacquires an expired lease. */ }
  }

  const renewEveryMs = options.renewEveryMs ?? 15_000
  const timer = host.renewLease && renewEveryMs > 0 ? setInterval(() => { void renewQuietly() }, renewEveryMs) : undefined

  async function save(): Promise<{ ok: boolean; conflict?: boolean; revision?: string }> {
    if (closed || saving) return { ok: false }
    saving = true
    const submitted = blocks.map((block) => ({ ...block }))
    const submittedRevision = revision
    try {
      await ensureLease()
      const committed = await host.commitDocx(fileId, {
        baseRevision: submittedRevision,
        leaseEpoch,
        idempotencyKey: crypto.randomUUID(),
        blocks: payload(submitted),
      })
      opened = await host.readDocx(fileId)
      revision = opened.file.revision || committed.revision
      const serverBlocks = opened.blocks.map((block) => ({ ...block }))
      if (sameText(submitted, blocks)) {
        blocks = serverBlocks
        dirty = false
        undoStack.length = 0
      } else {
        blocks = keepNewerEdits(serverBlocks, submitted, blocks)
        dirty = true
      }
      draw()
      return { ok: true, revision }
    } catch (error) {
      if (errorCode(error) === 'CONFLICT') return { ok: false, conflict: true }
      return { ok: false }
    } finally {
      saving = false
    }
  }

  function destroy(): void {
    closed = true
    if (timer !== undefined) clearInterval(timer)
    element.replaceChildren()
  }

  draw()
  return { getState: snapshot, updateText, undo, save, destroy }
}
