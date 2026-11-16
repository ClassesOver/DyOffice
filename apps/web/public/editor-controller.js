/** Local save bookkeeping for the DOCX page. Durable success is only a committed HTTP revision. */

export function createSaveGuard() {
  let generation = 0
  let savedGeneration = 0
  let pending = null
  let status = 'idle'
  return {
    markEdited() {
      generation += 1
    },
    beginSave() {
      if (pending) throw new Error('A save is already pending')
      pending = Object.freeze({ generation })
      status = 'saving'
      return pending
    },
    settleSave(ticket, outcome) {
      if (!pending || ticket !== pending) return false
      if (outcome === 'unknown') {
        status = 'unknown'
        return true
      }
      if (outcome !== 'committed' && outcome !== 'failed') throw new Error('Invalid save outcome')
      if (outcome === 'committed') savedGeneration = ticket.generation
      pending = null
      status = 'idle'
      return true
    },
    reset() {
      generation = savedGeneration = 0
      pending = null
      status = 'idle'
    },
    getState() {
      return { generation, savedGeneration, dirty: generation !== savedGeneration, status }
    },
  }
}

function tag(blocks, keySeq) {
  return blocks.map(block => ({ ...block, key: block.key || `b${keySeq.count++}` }))
}

function payloadOf(blocks) {
  return blocks.filter(block => !(block.deleted && block.docxIndex === undefined)).map(block => {
    if (block.deleted) return { docxIndex: block.docxIndex, deleted: true }
    if (block.docxIndex === undefined) return { text: block.text }
    if (block.editable) return { docxIndex: block.docxIndex, text: block.text }
    return { docxIndex: block.docxIndex }
  })
}

function rebase(serverBlocks, baseline, local) {
  const baseByIndex = new Map(baseline.filter(block => block.docxIndex !== undefined).map(block => [block.docxIndex, block]))
  const localByIndex = new Map(local.filter(block => block.docxIndex !== undefined).map(block => [block.docxIndex, block]))
  const baselineKeys = new Set(baseline.map(block => block.key))
  const merged = serverBlocks.map(block => {
    const mine = localByIndex.get(block.docxIndex)
    const base = baseByIndex.get(block.docxIndex)
    if (!mine || !base || !block.editable) return block
    if (mine.deleted && !base.deleted) return { ...block, deleted: true, key: mine.key }
    if (mine.text !== base.text) return { ...block, text: mine.text, key: mine.key }
    return { ...block, key: mine.key }
  })
  // Paragraphs created after the request was sent have no server identity yet.
  for (const block of local) {
    if (block.deleted || block.docxIndex !== undefined || baselineKeys.has(block.key)) continue
    merged.push({ ...block })
  }
  return merged
}

function structuralChange(blocks) {
  return blocks.some(block => block.deleted || block.docxIndex === undefined)
}

/**
 * Opens a DOCX projection, tracks local edits, and commits them.
 * A lost response stays unknown until the document is opened again.
 * Edits made while the request is in flight stay dirty after a commit.
 */
export function createEditorSession({ readDocx, acquireLease, commitDocx, renewLease, newKey = () => crypto.randomUUID() }) {
  const guard = createSaveGuard()
  const keySeq = { count: 1 }
  let fileId = null
  let baseRevision = null
  let leaseEpoch = null
  let blocks = []
  const snapshot = () => ({ fileId, baseRevision, leaseEpoch, blocks: blocks.map(block => ({ ...block })), ...guard.getState() })
  return {
    getState: snapshot,
    async open(id) {
      const lease = await acquireLease(id)
      const doc = await readDocx(id)
      guard.reset()
      fileId = id
      leaseEpoch = lease.leaseEpoch
      baseRevision = doc.file.revision
      blocks = tag(doc.blocks, keySeq)
      return snapshot()
    },
    updateBlock(index, text) {
      const block = blocks[index]
      if (!block?.editable || block.deleted) throw new Error('该段落不能编辑')
      blocks = blocks.map((item, itemIndex) => itemIndex === index ? { ...item, text } : item)
      guard.markEdited()
      return snapshot()
    },
    insertParagraph() {
      blocks = [...blocks, { key: `n${keySeq.count++}`, type: 'paragraph', text: '', editable: true }]
      guard.markEdited()
      return snapshot()
    },
    deleteBlock(index) {
      const block = blocks[index]
      if (!block?.editable || block.deleted) throw new Error('该内容不能删除')
      if (block.docxIndex === undefined) blocks = blocks.filter((_, itemIndex) => itemIndex !== index)
      else blocks = blocks.map((item, itemIndex) => itemIndex === index ? { ...item, deleted: true } : item)
      guard.markEdited()
      return snapshot()
    },
    async renew() {
      if (!renewLease || !fileId || leaseEpoch == null) return snapshot()
      const renewed = await renewLease(fileId, leaseEpoch)
      if (!renewed || typeof renewed.leaseEpoch !== 'number') throw new Error('租约续期无效')
      leaseEpoch = renewed.leaseEpoch
      return snapshot()
    },
    async save() {
      if (guard.getState().status === 'unknown') return { ok: false, unknown: true, state: snapshot() }
      if (renewLease) {
        try {
          const renewed = await renewLease(fileId, leaseEpoch)
          if (!renewed || typeof renewed.leaseEpoch !== 'number') throw new Error('租约续期无效')
          leaseEpoch = renewed.leaseEpoch
        } catch (error) {
          const status = error?.status
          if (status === 409) return { ok: false, conflict: true, state: snapshot() }
          if (status === 400) return { ok: false, invalid: true, state: snapshot() }
          return { ok: false, state: snapshot() }
        }
      }
      let ticket
      try { ticket = guard.beginSave() }
      catch { return { ok: false, pending: true, state: snapshot() } }
      const baseline = blocks.map(block => ({ ...block }))
      try {
        const revision = await commitDocx(fileId, {
          baseRevision,
          leaseEpoch,
          idempotencyKey: newKey(),
          blocks: payloadOf(baseline),
        })
        const structural = structuralChange(baseline)
        try {
          const doc = await readDocx(fileId)
          guard.settleSave(ticket, 'committed')
          baseRevision = doc.file.revision
          const serverBlocks = tag(doc.blocks, keySeq)
          blocks = guard.getState().dirty ? rebase(serverBlocks, baseline, blocks) : serverBlocks
        } catch {
          // A structural commit changes docxIndex values. Saving again from the
          // pre-save projection would be rejected, so wait for a fresh open.
          if (structural) {
            guard.settleSave(ticket, 'unknown')
            return { ok: false, unknown: true, state: snapshot() }
          }
          guard.settleSave(ticket, 'committed')
          baseRevision = revision.revision
          if (!guard.getState().dirty) blocks = baseline.filter(block => !block.deleted)
        }
        return { ok: true, revision, state: snapshot() }
      } catch (error) {
        const status = error?.status
        if (status === 400 || status === 409) {
          guard.settleSave(ticket, 'failed')
          return { ok: false, conflict: status === 409, invalid: status === 400, state: snapshot() }
        }
        guard.settleSave(ticket, 'unknown')
        return { ok: false, unknown: true, state: snapshot() }
      }
    },
  }
}
