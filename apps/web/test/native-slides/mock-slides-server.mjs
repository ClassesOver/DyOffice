import {createHash, randomUUID} from 'node:crypto'

/**
 * In-memory stand-in for the T10 slides service routes, mirroring the contract
 * the browser bridge speaks (apps/web/src/editors/slides-bridge.ts) and the
 * in-process pptx-session semantics the server module implements:
 *
 *   POST /api/v1/files/:id/slides/open     {revision, generation} -> {generation, dirty, size, defaultFont, slides, history}
 *   POST /api/v1/files/:id/slides/slide    {revision, generation, index} -> RenderSlide
 *   POST /api/v1/files/:id/slides/slides   {revision, generation} -> {generation, slides}
 *   POST /api/v1/files/:id/slides/apply    {revision, generation, ops} ->
 *                                          {generation, dirty, changed, created?, order?, index?, sections?, history}
 *   POST /api/v1/files/:id/slides/undo     {revision, generation} -> {generation, dirty, slides|null, history}
 *   POST /api/v1/files/:id/slides/redo     {revision, generation} -> {generation, dirty, slides|null, history}
 *   POST /api/v1/files/:id/slides/export   {revision, generation} -> {sha256, size, base64}
 *   POST /api/v1/files/:id/slides/uploads  {baseRevision, leaseEpoch, editorId, request:{revision, generation}} ->
 *                                          {uploadId, baseRevision, leaseEpoch, sha256, size, touchedEntries}
 *
 * Sessions are pinned to (fileId, revision) like the server module: every body
 * carries {revision, generation}; generation is the optimistic-concurrency
 * token every mutation bumps (a stale generation conflicts). Apply reports
 * changed indices and the structural order — renders are refetched via
 * slide/slides. Open is idempotent at the current generation; a session whose
 * pinned revision was committed away is adopted at the new head revision.
 * The deck model is a slide array of text elements; undo/redo are snapshots.
 */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function renderSlide(slide) {
  return {
    widthPx: 1280,
    heightPx: 720,
    scale: 1,
    background: {kind: 'none'},
    nodes: slide.elements.map((element) => ({
      type: 'text',
      sourceId: element.id,
      text: element.text,
    })),
    partPath: slide.partPath,
  }
}

function freshDeck(slideCount) {
  const slides = []
  for (let index = 0; index < slideCount; index++) {
    slides.push({
      partPath: `ppt/slides/slide${index + 1}.xml`,
      notes: '',
      elements: [{id: `e${index + 1}-title`, text: `Slide ${index + 1} title`}],
    })
  }
  return slides
}

export function createSlidesMockServer({name = 'deck.pptx', slideCount = 3} = {}) {
  const fileId = randomUUID()
  const initialBytes = new TextEncoder().encode('mock-pptx-head-v0')
  const file = {fileId, name, format: 'pptx', revision: randomUUID(), sha256: sha256(initialBytes), size: initialBytes.byteLength}
  const revisions = new Map([[file.revision, initialBytes]])
  const csrfToken = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43)
  const lease = {epoch: 0, editorId: null, expiresAt: null}
  const uploads = new Map()
  const commits = new Map()
  const appliedOps = []
  let preparations = 0
  let session = null

  const snapshot = () => JSON.stringify(session.deck)
  const dirty = () => snapshot() !== session.saved
  const order = () => session.deck.map((slide) => slide.partPath)
  const history = () => ({canUndo: session.undo.length > 0, canRedo: session.redo.length > 0})

  function openSession(requestedRevision) {
    if (requestedRevision !== file.revision) throw httpError(409, 'CONFLICT', 'session head moved')
    // A session already pinned at the current head (any generation) is reused:
    // open is idempotent. A session whose own save committed a new head adopts
    // lazily when a call arrives pinned at the new revision; without a session
    // the deck is parsed fresh from the head bytes (generation 0).
    if (session) {
      if (session.revision === file.revision) return session
      if (requestedRevision === session.pendingAdoption) { session.revision = requestedRevision; delete session.pendingAdoption; return session }
      return session
    }
    const deck = freshDeck(slideCount)
    session = {revision: file.revision, generation: 0, deck, saved: JSON.stringify(deck), undo: [], redo: []}
    return session
  }

  function nextPartPath(slides) {
    let max = 0
    for (const slide of slides) max = Math.max(max, Number(/slide(\d+)\.xml$/.exec(slide.partPath)?.[1] ?? 0))
    return `ppt/slides/slide${max + 1}.xml`
  }

  function applyOps(list) {
    const before = snapshot()
    const changed = []
    const created = []
    let index, orderChanged = false
    for (const op of list) {
      const slideIndex = op.target?.slide
      if (op.op === 'setText') {
        const slide = session.deck[slideIndex]
        const element = slide?.elements.find((item) => item.id === op.target.el)
        if (!element) throw httpError(409, 'CONFLICT', 'setText target')
        element.text = op.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join('')).join('\n')
        if (!changed.includes(slideIndex)) changed.push(slideIndex)
      } else if (op.op === 'duplicateSlide' || op.op === 'addBlankSlide') {
        if (!session.deck[slideIndex]) throw httpError(409, 'CONFLICT', 'slide target')
        const next = op.op === 'duplicateSlide'
          ? {partPath: nextPartPath(session.deck), notes: session.deck[slideIndex].notes, elements: session.deck[slideIndex].elements.map((element) => ({...element, text: op.clearText ? '' : element.text, id: element.id + '-copy'}))}
          : {partPath: nextPartPath(session.deck), notes: '', elements: []}
        session.deck.splice(slideIndex + 1, 0, next)
        index = slideIndex + 1
        changed.push(index)
        orderChanged = true
      } else if (op.op === 'deleteSlide') {
        if (session.deck.length <= 1) throw httpError(409, 'CONFLICT', 'last slide')
        if (!session.deck[slideIndex]) throw httpError(409, 'CONFLICT', 'slide target')
        session.deck.splice(slideIndex, 1)
        orderChanged = true
      } else if (op.op === 'moveSlide') {
        const to = op.to
        if (!Number.isInteger(to) || to < 0 || to >= session.deck.length || !session.deck[slideIndex]) throw httpError(409, 'CONFLICT', 'moveSlide target')
        const [moved] = session.deck.splice(slideIndex, 1)
        session.deck.splice(to, 0, moved)
        orderChanged = true
      } else if (op.op === 'setNotes') {
        const slide = session.deck[slideIndex]
        if (!slide) throw httpError(409, 'CONFLICT', 'slide target')
        slide.notes = String(op.text)
        if (!changed.includes(slideIndex)) changed.push(slideIndex)
      } else if (op.op === 'addElement') {
        const slide = session.deck[slideIndex]
        if (!slide) throw httpError(409, 'CONFLICT', 'slide target')
        const id = 'e' + randomUUID().slice(0, 8)
        const paragraphs = op.paragraphs ?? (op.text ? String(op.text).split('\n').map(text => ({runs: [{text}]})) : [])
        slide.elements.push({id, text: paragraphs.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n')})
        created.push(id)
        if (!changed.includes(slideIndex)) changed.push(slideIndex)
      } else if (op.op === 'deleteElement') {
        const slide = session.deck[slideIndex]
        const at = slide?.elements.findIndex((item) => item.id === op.target.el)
        if (at === undefined || at < 0) throw httpError(409, 'CONFLICT', 'deleteElement target')
        slide.elements.splice(at, 1)
        if (!changed.includes(slideIndex)) changed.push(slideIndex)
      } else if (op.op === 'setTransform') {
        const slide = session.deck[slideIndex]
        const element = slide?.elements.find((item) => item.id === op.target.el)
        if (!element) throw httpError(409, 'CONFLICT', 'setTransform target')
        element.box = op.box
        if (!changed.includes(slideIndex)) changed.push(slideIndex)
      } else if (op.op === 'setTransition') {
        const slide = session.deck[slideIndex]
        if (!slide) throw httpError(409, 'CONFLICT', 'slide target')
        slide.transition = String(op.kind)
        if (!changed.includes(slideIndex)) changed.push(slideIndex)
      } else throw httpError(409, 'CONFLICT', 'unsupported op ' + op.op)
    }
    const structural = orderChanged
    if (snapshot() !== before) {
      session.undo.push(before)
      session.redo = []
      session.generation++
    }
    return {changed: changed.sort((a, b) => a - b), created, index, structural}
  }

  function leaseReply(editorId) {
    lease.epoch++
    lease.editorId = editorId
    lease.expiresAt = new Date(Date.now() + 60_000).toISOString()
    return {leaseEpoch: lease.epoch, editorId, expiresAt: lease.expiresAt}
  }

  function httpError(status, code, detail) {
    return Object.assign(new Error(code + ': ' + detail), {status, code, detail})
  }

  const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}})

  function requireSession(body) {
    if (!session) throw httpError(409, 'CONFLICT', 'unknown slides session')
    if (body?.revision !== session.revision) {
      if (body?.revision === session.pendingAdoption) { session.revision = body.revision; delete session.pendingAdoption; return session }
      throw httpError(409, 'CONFLICT', 'unknown slides session')
    }
    return session
  }

  function requireGeneration(current, expected) {
    if (!Number.isSafeInteger(expected) || expected !== current.generation) throw httpError(409, 'CONFLICT', 'generation moved')
  }

  async function handle(path, init) {
    const method = (init.method ?? 'GET').toUpperCase()
    if (path === '/api/v1/auth/csrf') return json({csrfToken})
    if (path === '/api/preferences') return json({language: 'en', theme: 'light', autoSave: false, authorName: 'Alice'})
    if (method !== 'GET' && new Headers(init.headers).get('x-csrf-token') !== csrfToken) return json({error: 'csrf'}, 403)
    const body = init.body ? JSON.parse(init.body) : {}

    const fileMatch = /^\/api\/v1\/files\/([^/]+)(.*)$/.exec(path)
    if (fileMatch && fileMatch[1] !== fileId) return json({error: 'unknown file'}, 404)
    if (fileMatch && /^\/lease(\/(renew|takeover))?$/.test(fileMatch[2])) {
      if (method === 'GET') return json({leaseEpoch: lease.epoch})
      if (method === 'DELETE') {
        if (lease.editorId !== body.editorId || lease.epoch !== body.leaseEpoch) return json({error: 'lease'}, 409)
        lease.editorId = null
        return new Response(null, {status: 204})
      }
      if (method === 'POST' && fileMatch[2] === '/lease/renew') {
        if (lease.editorId !== body.editorId || lease.epoch !== body.leaseEpoch) return json({error: 'lease'}, 409)
        lease.expiresAt = new Date(Date.now() + 60_000).toISOString()
        return json({leaseEpoch: lease.epoch, editorId: body.editorId, expiresAt: lease.expiresAt})
      }
      if (method === 'POST' && fileMatch[2] === '/lease/takeover') {
        if (lease.epoch !== body.expectedEpoch) return json({error: 'lease'}, 409)
        return json(leaseReply(body.editorId))
      }
      if (method === 'POST') {
        if (lease.editorId && lease.editorId !== body.editorId) return json({error: 'held'}, 409)
        return json(leaseReply(body.editorId))
      }
    }
    if (fileMatch) switch (fileMatch[2]) {
      case '': return json({
        file: {fileId, revision: file.revision, sha256: file.sha256, size: file.size},
        name: file.name,
        format: file.format,
        downloadEndpoint: `/api/v1/files/${fileId}/content`,
        capabilities: {docx: 'editable', xlsx: 'editable', pptx: 'editable', pdf: 'read_only'},
      })
      case '/commits': {
        // T06 idempotency: a replayed commit returns the recorded receipt even
        // though the head has moved past its base revision.
        if (commits.has(body.idempotencyKey)) return json(commits.get(body.idempotencyKey))
        const staged = uploads.get(body.uploadId)
        if (!staged) return json({error: 'upload'}, 409)
        if (body.baseRevision !== file.revision || body.leaseEpoch !== lease.epoch) return json({error: 'head moved'}, 409)
        file.revision = randomUUID()
        file.sha256 = staged.sha256
        file.size = staged.size
        revisions.set(file.revision, staged.bytes)
        const ref = {fileId, revision: file.revision, sha256: file.sha256, size: file.size}
        commits.set(body.idempotencyKey, ref)
        // The session stays pinned at its exported revision; calls carrying the
        // new head adopt it lazily (mirrors the service adoption contract).
        if (session) session.pendingAdoption = file.revision
        return json(ref)
      }
    }

    const slidesMatch = fileMatch ? /^\/slides\/(\w+)/.exec(fileMatch[2]) : null
    if (slidesMatch) {
      const route = slidesMatch[1]
      if (route === 'uploads') {
        preparations++
        if (body.baseRevision !== file.revision) return json({error: 'base head'}, 409)
        if (body.leaseEpoch !== lease.epoch || !lease.editorId) return json({error: 'lease'}, 409)
        const current = requireSession(body.request)
        requireGeneration(current, body.request?.generation)
        const bytes = new TextEncoder().encode('mock-pptx-export:' + snapshot())
        const uploadId = randomUUID()
        uploads.set(uploadId, {sha256: sha256(bytes), size: bytes.byteLength, bytes, baseRevision: body.baseRevision})
        if (session) session.savedAtExport = snapshot()
        // Receipt shape mirrors the slides save service: {uploadId, baseRevision, leaseEpoch, sha256, size}.
        return json({uploadId, baseRevision: body.baseRevision, leaseEpoch: body.leaseEpoch, sha256: sha256(bytes), size: bytes.byteLength})
      }
      if (route === 'export') {
        const current = requireSession(body)
        requireGeneration(current, body.generation)
        const bytes = new TextEncoder().encode('mock-pptx-export:' + snapshot())
        return json({sha256: sha256(bytes), size: bytes.byteLength, base64: Buffer.from(bytes).toString('base64')})
      }
      if (route === 'open') {
        if (body.revision !== file.revision) return json({error: 'head moved'}, 409)
        const opened = openSession(body.revision)
        requireGeneration(opened, body.generation)
        return json({
          generation: opened.generation,
          dirty: dirty(),
          size: {cx: 12192000, cy: 6858000},
          defaultFont: 'Calibri',
          slides: opened.deck.map(renderSlide),
          history: history(),
        })
      }
      const current = requireSession(body)
      if (route === 'slide') {
        const slide = current.deck[body.index]
        if (!slide) return json({error: 'index'}, 409)
        return json(renderSlide(slide))
      }
      if (route === 'slides') return json({generation: current.generation, slides: current.deck.map(renderSlide)})
      if (route === 'apply') {
        if (!Array.isArray(body.ops) || body.ops.length === 0) return json({error: 'ops'}, 409)
        requireGeneration(current, body.generation)
        appliedOps.push(...body.ops)
        const result = applyOps(body.ops)
        return json({
          generation: current.generation,
          dirty: dirty(),
          changed: result.changed,
          ...(result.created.length ? {created: result.created} : {}),
          ...(result.structural ? {order: order(), sections: [], index: result.index} : {}),
          history: history(),
        })
      }
      if (route === 'undo' || route === 'redo') {
        requireGeneration(current, body.generation)
        const stack = route === 'undo' ? current.undo : current.redo
        const other = route === 'undo' ? current.redo : current.undo
        if (!stack.length) return json({generation: current.generation, dirty: dirty(), slides: null, history: history()})
        const target = stack.pop()
        other.push(snapshot())
        current.deck = JSON.parse(target)
        current.generation++
        return json({generation: current.generation, dirty: dirty(), slides: current.deck.map(renderSlide), history: history()})
      }
    }
    if (path === `/api/v1/files/${fileId}/content`) {
      const bytes = revisions.get(new URLSearchParams(path.split('?')[1] ?? '').get('revision') ?? file.revision) ?? initialBytes
      return new Response(bytes, {status: 200, headers: {'content-type': 'application/octet-stream'}})
    }
    return json({error: 'not found', path}, 404)
  }

  return {
    fetchImpl: async (path, init = {}) => {
      try {
        return await handle(String(path), init)
      } catch (error) {
        if (error.status) return json({error: error.code, detail: error.detail}, error.status)
        throw error
      }
    },
    file: () => ({...file}),
    sessionState: () => session ? {revision: session.revision, generation: session.generation, count: session.deck.length, dirty: dirty()} : null,
    appliedOps: () => appliedOps.map((op) => structuredClone(op)),
    preparations: () => preparations,
    grantLeaseTo: (editorId) => { lease.epoch++; lease.editorId = editorId; lease.expiresAt = new Date(Date.now() + 60_000).toISOString() },
    csrfToken,
  }
}
