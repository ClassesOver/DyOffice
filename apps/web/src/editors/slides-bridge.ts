import type {SessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {hostError} from '../../../../packages/web-contracts/src/errors.ts'
import {messages} from './messages.ts'
import type {AiPanelPrefs} from '@genoffice/ui'
import type {
  SlidesApi, OpenResult, SlideUpdate, SectionInfo, UiTheme, AutoSaveDefault,
  AiSettings, TransitionKind, ShowTiming, GetLayoutsResult, SlideComment, AnimationItem, ShapeKey,
  EditTextOp, AddSlideOp, AddBlankSlideOp, MoveSlideOp, AddElementOp, DeleteElementOp,
  DeleteElementsOp, EditTransformOp, EditTransformMultiOp, BatchEditTransformOp, ReorderElementOp,
  GroupElementsOp, UngroupElementOp, SetElementFontOp, SetElementParagraphFormatOp,
  FindReplaceOp, SetNotesOp, SetTransitionOp, SetSlideHiddenOp, SetSlideLayoutOp,
  AddSectionOp, RenameSectionOp, RemoveSectionOp, MoveSectionOp,
  HeaderFooterOp, AddSlideWithLayoutOp, LinkTargetOp,
} from '../../../slides/src/shared/ipc'

type Preferences = Awaited<ReturnType<SessionFileHost['getPreferences']>>
type SaveResult = {ok: boolean; path?: string; error?: string}
type SaveReceipt = Awaited<ReturnType<SessionFileHost['saveSlides']>>
type Recovery = {saved?: SaveReceipt; resolve(value: SaveResult): void; reject(error: unknown): void}
/** The server pptx session: pinned to the file revision, fenced by generation. */
type Session = {revision: string; generation: number; dirty: boolean; size: {cx: number; cy: number}; defaultFont: string}
type ApplyResponse = {generation: number; dirty: boolean; changed?: number[]; created?: string[]; order?: string[]; index?: number; sections?: SectionInfo[] | null; history?: {canUndo: boolean; canRedo: boolean}}
type HistoryState = {canUndo: boolean; canRedo: boolean}

export function createSlidesBridge(host: SessionFileHost, fileId: string, prefs: Preferences, {fetchImpl = fetch, onChange = () => {}}: {fetchImpl?: typeof fetch; onChange?: () => void} = {}) {
  let session: Session | null = null
  const controllers = new Set<AbortController>()
  const text = messages[prefs.language === 'en' ? 'en' : 'zh']
  let recovery: Recovery | null = null, confirming = false
  const inFlight = {count: 0}
  const waiting: (() => void)[] = []
  const historyHandlers = new Set<(state: HistoryState) => void>()
  const openedHandlers = new Set<(result: OpenResult) => void>()
  const notesBySlide = new Map<number, string>()
  const transitions = new Map<number, TransitionKind>()
  let sections: SectionInfo[] = []
  let csrf: string | undefined, disposed = false
  let pendingOpen: Promise<OpenResult> | null = null
  const noEvent = () => () => {}
  const unavailable = async (): Promise<never> => { throw new Error(text.unavailable) }
  const graceful = async (): Promise<null> => null
  const gracefulFalse = async (): Promise<false> => false

  function requireSession(): Session {
    if (disposed || !session) throw hostError('INVALID_REVISION', 'slides session')
    return session
  }
  function emitHistory(state: HistoryState | undefined) {
    if (!state) return
    for (const handler of historyHandlers) { try { handler(state) } catch { /* renderer listeners cannot change durable results */ } }
  }
  async function request(revision: string, generation: number, method: string, input: object = {}) {
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    const controller = new AbortController(); controllers.add(controller)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!csrf) {
          const response = await fetchImpl('/api/v1/auth/csrf', {credentials: 'same-origin', cache: 'no-store', signal: controller.signal})
          if (!response.ok) throw hostError('UNAUTHORIZED', 'session')
          const body = await response.json()
          if (typeof body?.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.csrfToken)) throw hostError('INVALID_RESPONSE', 'csrf')
          csrf = body.csrfToken
        }
        const proof = csrf
        const response = await fetchImpl(`/api/v1/files/${fileId}/slides/${method}`, {method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: {'content-type': 'application/json', 'x-csrf-token': proof!}, body: JSON.stringify({revision, generation, ...input, editorId:host.getState(fileId).lease?.editorId, leaseEpoch:host.getState(fileId).lease?.leaseEpoch})})
        if (response.status === 403 && attempt === 0) { if (csrf === proof) csrf = undefined; continue }
        if (!response.ok) throw hostError(response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 409 ? 'CONFLICT' : 'UNAVAILABLE', 'slides call')
        if (!response.headers.get('content-type')?.includes('application/json')) throw hostError('INVALID_RESPONSE', 'slides call')
        return await response.json()
      }
    } finally { controllers.delete(controller) }
  }
  async function call(revision: string, generation: number, method: string, input: object = {}) {
    if (waiting.length >= 64) throw hostError('UNAVAILABLE', 'read capacity')
    if (inFlight.count >= 2) await new Promise<void>(resolve => waiting.push(resolve))
    else inFlight.count++
    try { return await request(revision, generation, method, input) }
    finally { const next = waiting.shift(); if (next) next(); else inFlight.count-- }
  }
  /** Reopen (or idempotently refresh) the revision-pinned pptx session. `fire` pushes onOpened like the desktop main process does for externally opened files. */
  async function openSession(fire: boolean): Promise<OpenResult> {
    const state = host.getState(fileId)
    const generation = session && session.revision === state.revision.revision ? session.generation : 0
    const raw = await call(state.revision.revision, generation, 'open') as {generation: number; dirty: boolean; size?: {cx: number; cy: number}; defaultFont?: string; slides: OpenResult['slides']}
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    session = {revision: state.revision.revision, generation: raw.generation, dirty: !!raw.dirty, size: raw.size ?? {cx: 12192000, cy: 6858000}, defaultFont: raw.defaultFont ?? 'Calibri'}
    const result: OpenResult = {path: state.name, slides: raw.slides, size: session.size, defaultFont: session.defaultFont}
    if (fire) for (const handler of openedHandlers) { try { handler(result) } catch { /* renderer listeners cannot change durable results */ } }
    return result
  }
  /** Every body carries the pinned {revision, generation}; a moved head or a stale generation conflicts. */
  async function applyOps(ops: unknown[]): Promise<ApplyResponse | null> {
    const current = requireSession()
    // No lease, no mutation: unowned edits never reach the server session.
    // An unconfirmed receipt parks mutations too: the pinned revision may be
    // dead once the staged commit landed, so edits wait for the confirmation
    // that adopts the committed head.
    if (recovery || !host.getState(fileId).lease) return null
    const raw = await call(current.revision, current.generation, 'apply', {ops}) as ApplyResponse
    current.generation = raw.generation
    current.dirty = !!raw.dirty
    if (Array.isArray(raw.sections)) sections = raw.sections
    for (const op of ops) {
      if (op && typeof op === 'object' && (op as {op?: string}).op === 'setNotes') {
        const target = (op as {target?: {slide?: unknown}}).target
        if (target && typeof target.slide === 'number') notesBySlide.set(target.slide, String((op as {text?: unknown}).text ?? ''))
      }
    }
    emitHistory(raw.history)
    return raw
  }
  async function fetchSlide(index: number): Promise<OpenResult['slides'][number]> {
    const current = requireSession()
    return await call(current.revision, current.generation, 'slide', {index}) as OpenResult['slides'][number]
  }
  async function fetchDeck(): Promise<{slides: OpenResult['slides']}> {
    const current = requireSession()
    return await call(current.revision, current.generation, 'slides') as {slides: OpenResult['slides']}
  }
  /** fitWidthPx viewport coordinates map linearly onto the slide's EMU width. */
  function emuBox(current: Session, fitWidthPx: number, xPx: number, yPx: number, wPx: number, hPx: number) {
    const scale = current.size.cx / Math.max(1, fitWidthPx)
    return {x: Math.round(xPx * scale), y: Math.round(yPx * scale), cx: Math.round(wPx * scale), cy: Math.round(hPx * scale)}
  }
  const slideUpdateFrom = (order: string[], deck: {slides: OpenResult['slides']}) => ({order, slides: deck.slides})
  const op = (name: string, fields: Record<string, unknown>) => ({op: name, ...fields})

  const api = {
    getLanguage: async () => prefs.language === 'en' ? 'en' as const : 'zh' as const,
    getTheme: async (): Promise<UiTheme> => prefs.theme,
    getAutoSaveDefault: async (): Promise<AutoSaveDefault> => ({on: prefs.autoSave === true, updatedAt: 1}),
    getAiPanelPrefs: async (): Promise<AiPanelPrefs> => ({side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: true, showAiSidebar: false, showAiAskTrigger: false} as AiPanelPrefs),
    setAiPanelPrefs: async (patch: Partial<AiPanelPrefs>) => ({side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: true, showAiSidebar: false, showAiAskTrigger: false, ...patch} as AiPanelPrefs),
    getAiSettings: async () => ({provider: 'genspark', providers: {}}) as unknown as AiSettings,
    setAiSettings: async () => {},
    onLanguageChanged: noEvent, onThemeChanged: noEvent, onAutoSaveDefaultChanged: noEvent,
    onAiPanelPrefsChanged: noEvent, onAiSettingsChanged: noEvent,
    onChromePressed: noEvent, onFontsChanged: noEvent, onMenuCommand: noEvent, onRenamed: noEvent,
    onCloseSaveRequest: noEvent, onDeckChanged: noEvent, onAiStream: noEvent,
    reportCloseSaveResult() {}, setAutoSavePref() {}, headlessExportDone() {},
    consumeHeadlessExport: async () => null,
    openPptx: async (_fitWidthPx: number) => await openSession(true),
    consumePendingOpen: async (_fitWidthPx: number) => { pendingOpen ??= openSession(false); return await pendingOpen },
    openPptxPath: unavailable, newBlank: unavailable, saveAs: unavailable, landGeneratedPages: unavailable,
    localGeneratePage: unavailable, pickExportDir: unavailable, pickExportPdfPath: unavailable,
    pickExportVideoPath: unavailable, pickPictureFile: unavailable, insertImage: unavailable,
    insertMedia: unavailable, addMediaBytes: unavailable, getMediaData: graceful,
    pickModel3d: unavailable, addModel3d: unavailable, setModel3dView: graceful, getModel3dData: graceful,
    videoFileOpen: unavailable, videoFileWrite: unavailable, videoFileClose: unavailable,
    savePicture: unavailable, exportImages: unavailable, exportPdf: unavailable,
    printSlides: unavailable, listPrinters: unavailable, printerOptions: unavailable,
    fontCatalog: unavailable, fontDownload: unavailable, fontInstallLocal: unavailable,
    privateFontFaces: async () => [], privateFontData: async () => null, fontMissing: async () => <string[]>[],
    microphoneAccess: async () => false, getRecentFiles: async () => <string[]>[],
    setShowFullScreen: async () => {}, nativeClipboard: async () => {},
    clipboardExternal: async () => ({kind: 'none'} as const), clipboardProbe: async () => false,
    hasSlideClipboard: async () => false, copySlides: gracefulFalse, copyElements: async () => 0,
    copyElementsImage: gracefulFalse, pasteElements: graceful, duplicateElements: graceful,
    pasteSlide: graceful, repasteSlide: graceful,
    beginHistoryBatch: async () => true, endHistoryBatch: async () => null,
    applyEditScript: unavailable, applyTxn: (async () => null) as SlidesApi['applyTxn'],
    aiSnapshotRestore: graceful,
    async getRenderSlides() {
      const current = session
      if (disposed || !current) return null
      const raw = await call(current.revision, current.generation, 'slides') as {slides: OpenResult['slides']}
      return raw.slides
    },
    async getSlideSize() { return session ? {...session.size} : null },
    async isDirty() { return session?.dirty ?? false },
    async editText(input: EditTextOp) {
      const payload = op('setText', {target: {slide: input.slideIndex, el: input.sourceId}, paragraphs: input.paragraphs, ...(input.groupId ? {group: input.groupId} : {})})
      const raw = await applyOps([payload])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async addElement(input: AddElementOp) {
      const current = requireSession()
      const paragraphs = input.paragraphs ?? (input.text !== undefined ? String(input.text).split('\n').map(line => ({runs: [{text: line}]})) : [])
      const payload = op('addElement', {target: {slide: input.slideIndex}, kind: input.kind, offset: emuBox(current, input.fitWidthPx, input.xPx, input.yPx, input.wPx, input.hPx), ...(paragraphs.length ? {paragraphs} : {}), ...(input.fillColor ? {fill: input.fillColor} : {}), ...(input.stroke ? {stroke: input.stroke} : {}), ...(input.bodyPr ? {bodyPr: input.bodyPr} : {})})
      const raw = await applyOps([payload])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), sourceId: raw.created?.[0] ?? ''}
    },
    async deleteElement(input: DeleteElementOp) {
      const raw = await applyOps([op('deleteElement', {target: {slide: input.slideIndex, el: input.sourceId}})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async deleteElements(input: DeleteElementsOp) {
      const ops = input.sourceIds.map(id => op('deleteElement', {target: {slide: input.slideIndex, el: id}}))
      const raw = await applyOps(ops)
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editTransform(input: EditTransformOp) {
      // Drag previews stay local (each server transaction is an undo step); the release commit lands as one transaction.
      if (input.preview) return null
      const current = requireSession()
      const payload = op('setTransform', {target: {slide: input.slideIndex, el: input.sourceId}, box: emuBox(current, input.fitWidthPx, input.xPx, input.yPx, input.wPx, input.hPx), rotDeg: input.rotationDeg, ...(input.groupId ? {group: input.groupId} : {})})
      const raw = await applyOps([payload])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async editTransformMulti(input: EditTransformMultiOp) {
      const current = requireSession()
      const ops = input.items.map(item => op('setTransform', {target: {slide: input.slideIndex, el: item.sourceId}, box: emuBox(current, input.fitWidthPx, item.xPx, item.yPx, item.wPx, item.hPx), rotDeg: item.rotationDeg, ...(item.groupId ? {group: item.groupId} : {})}))
      const raw = await applyOps(ops)
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async batchEditTransform(input: BatchEditTransformOp) {
      const current = requireSession()
      const ops = input.items.map(item => op('setTransform', {target: {slide: input.slideIndex, el: item.sourceId}, box: emuBox(current, input.fitWidthPx, item.xPx, item.yPx, item.wPx, item.hPx), rotDeg: item.rotationDeg}))
      const raw = await applyOps(ops)
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async addSlide(input: AddSlideOp) {
      const raw = await applyOps([op('duplicateSlide', {target: {slide: input.sourceIndex}, ...(input.clearText ? {clearText: true} : {})})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), index: raw.index ?? -1, sections: raw.sections ?? []} as SlideUpdate & {index: number}
    },
    async addBlankSlide(input: AddBlankSlideOp) {
      const raw = await applyOps([op('addBlankSlide', {target: {slide: input.sourceIndex}})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), index: raw.index ?? -1, sections: raw.sections ?? []} as SlideUpdate & {index: number}
    },
    async addSlideWithLayout(input: AddSlideWithLayoutOp) {
      const raw = await applyOps([op('addSlideWithLayout', {target: {slide: input.sourceIndex}, layoutPath: input.layoutPath})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), index: raw.index ?? -1, sections: raw.sections ?? []} as SlideUpdate & {index: number}
    },
    async deleteSlide(slideIndex: number) {
      const raw = await applyOps([op('deleteSlide', {target: {slide: slideIndex}})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return slideUpdateFrom(raw.order, deck)
    },
    async moveSlide(input: MoveSlideOp) {
      const raw = await applyOps([op('moveSlide', {target: {slide: input.fromIndex}, to: input.toIndex})])
      if (!raw?.order) return null
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), sections: raw.sections ?? []}
    },
    async reorderElement(input: ReorderElementOp) {
      const raw = await applyOps([op('reorderElement', {target: {slide: input.slideIndex, el: input.sourceId}, dir: input.dir})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async groupElements(input: GroupElementsOp) {
      const raw = await applyOps([op('groupElements', {target: {slide: input.slideIndex}, els: input.sourceIds})])
      if (!raw?.changed?.length) return null
      return {slide: await fetchSlide(raw.changed[0]!), groupId: raw.created?.[0] ?? ''}
    },
    async ungroupElement(input: UngroupElementOp) {
      const raw = await applyOps([op('ungroupElement', {target: {slide: input.slideIndex, el: input.sourceId}})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setElementFont(input: SetElementFontOp) {
      const font = {...(input.fontFamily !== undefined ? {fontFamily: input.fontFamily} : {}), ...(input.fontSizePt !== undefined ? {fontSizePt: input.fontSizePt} : {}), ...(input.fontSizeStep !== undefined ? {fontSizeStep: input.fontSizeStep} : {}), ...(input.bold !== undefined ? {bold: input.bold} : {}), ...(input.italic !== undefined ? {italic: input.italic} : {}), ...(input.underline !== undefined ? {underline: input.underline} : {}), ...(input.strike !== undefined ? {strike: input.strike} : {}), ...(input.color !== undefined ? {color: input.color} : {})}
      const raw = await applyOps([op('setFont', {target: {slide: input.slideIndex, el: input.sourceIds[0] ?? ''}, font, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async setElementParagraphFormat(input: SetElementParagraphFormatOp) {
      const format: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input) as [keyof SetElementParagraphFormatOp, unknown][]) {
        if (['slideIndex', 'sourceIds', 'groupId'].includes(key)) continue
        if (value !== undefined) format[key] = value
      }
      const raw = await applyOps([op('setParagraphFormat', {target: {slide: input.slideIndex, el: input.sourceIds[0] ?? ''}, format, ...(input.groupId ? {group: input.groupId} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async findReplace(input: FindReplaceOp) {
      const raw = await applyOps([op('findReplace', {find: input.find, replace: input.replace, ...(input.matchCase !== undefined ? {matchCase: input.matchCase} : {}), ...(input.firstOnly !== undefined ? {firstOnly: input.firstOnly} : {}), ...(input.slideIndex !== undefined ? {slideIndex: input.slideIndex} : {}), ...(input.elementId !== undefined ? {elementId: input.elementId} : {})})])
      if (!raw?.changed?.length) return {count: 0, update: null}
      const deck = await fetchDeck()
      return {count: raw.changed.length, update: {order: deck.slides.map(slide => slide.partPath ?? ''), slides: deck.slides}}
    },
    async setSlideLayout(input: SetSlideLayoutOp) {
      const raw = await applyOps([op('setSlideLayout', {target: {slide: input.slideIndex}, ...(input.layoutPath ? {layout: input.layoutPath} : {})})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async applyHeaderFooter(input: HeaderFooterOp) {
      const raw = await applyOps([op('applyHeaderFooter', {settings: {footer: input.footer ?? null, slideNum: input.slideNum === true, date: input.date ?? null, ...(input.dateAuto !== undefined ? {dateAuto: input.dateAuto} : {})}})])
      if (!raw) return null
      const deck = await fetchDeck()
      return deck.slides
    },
    async setNotes(input: SetNotesOp) {
      const raw = await applyOps([op('setNotes', {target: {slide: input.slideIndex}, text: input.text})])
      return raw !== null
    },
    async getNotes(slideIndex: number) { return notesBySlide.get(slideIndex) ?? '' },
    async setTransition(input: SetTransitionOp) {
      const raw = await applyOps([op('setTransition', {target: {slide: input.slideIndex}, kind: input.kind})])
      if (raw) transitions.set(input.slideIndex, input.kind)
      return raw !== null
    },
    async getTransition(slideIndex: number) { return transitions.get(slideIndex) ?? 'none' as TransitionKind },
    async setSlideHidden(input: SetSlideHiddenOp) {
      const raw = await applyOps([op('setHidden', {target: {slide: input.slideIndex}, hidden: input.hidden})])
      if (!raw?.changed?.length) return null
      return await fetchSlide(raw.changed[0]!)
    },
    async getSections() { return sections },
    async setSections(input: SectionInfo[]) {
      const raw = await applyOps([op('setSections', {sections: input})])
      if (!raw) return null
      sections = input
      return sections
    },
    async addSection(input: AddSectionOp) {
      const raw = await applyOps([op('addSection', {atSlideIndex: input.atSlideIndex, name: input.name})])
      if (!raw) return null
      sections = raw.sections ?? sections
      return sections
    },
    async renameSection(input: RenameSectionOp) {
      const raw = await applyOps([op('renameSection', {id: input.id, name: input.name})])
      if (!raw) return null
      sections = raw.sections ?? sections
      return sections
    },
    async removeSection(input: RemoveSectionOp) {
      const raw = await applyOps([op('removeSection', {id: input.id})])
      if (!raw) return null
      sections = raw.sections ?? sections
      return sections
    },
    async moveSection(input: MoveSectionOp) {
      const raw = await applyOps([op('moveSection', {id: input.id, dir: input.dir})])
      if (!raw?.order) return null
      sections = raw.sections ?? []
      const deck = await fetchDeck()
      return {...slideUpdateFrom(raw.order, deck), sections}
    },
    async undo() {
      const current = session
      if (disposed || !current || recovery) return null
      if (!host.getState(fileId).lease) return null
      const raw = await call(current.revision, current.generation, 'undo') as {generation: number; dirty: boolean; slides: OpenResult['slides'] | null; history: HistoryState}
      current.generation = raw.generation
      current.dirty = !!raw.dirty
      emitHistory(raw.history)
      return raw.slides ?? null
    },
    async redo() {
      const current = session
      if (disposed || !current || recovery) return null
      if (!host.getState(fileId).lease) return null
      const raw = await call(current.revision, current.generation, 'redo') as {generation: number; dirty: boolean; slides: OpenResult['slides'] | null; history: HistoryState}
      current.generation = raw.generation
      current.dirty = !!raw.dirty
      emitHistory(raw.history)
      return raw.slides ?? null
    },
    async save() {
      if (disposed) throw hostError('UNAVAILABLE', 'disposed')
      const current = session
      if (!current) return {ok: false as const, error: text.failed}
      if (!host.getState(fileId).lease) return {ok: false as const, error: text.saveFailed}
      // A clean deck saves nothing: no export, no redundant revision. The renderer's
      // flushActiveEdit runs before this point, so an overlay edit that just committed
      // has already marked the session dirty and takes the full receipt path.
      if (!current.dirty) return {ok: true as const, path: host.getState(fileId).name}
      let saved: SaveReceipt | undefined
      try {
        saved = await host.saveSlides(fileId, {revision: current.revision, generation: current.generation})
      } catch (error) {
        if (!saved && host.getState(fileId).status !== 'unknown') return {ok: false as const, error: text.saveFailed}
        // The receipt is unknown: the renderer's save promise stays pending and
        // its exact journal survives until the entry's Confirm save outcome resolves it.
        return new Promise<SaveResult>((resolve, reject) => { recovery = {resolve, reject}; onChange() })
      }
      // Adopt the committed head: the pinned revision moved, the generation continues.
      current.revision = saved.revision
      current.dirty = false
      return {ok: true as const, path: host.getState(fileId).name}
    },
    onHistoryChanged(handler: (state: HistoryState) => void) {
      historyHandlers.add(handler)
      return () => { historyHandlers.delete(handler) }
    },
    onOpened(handler: (result: OpenResult) => void) {
      openedHandlers.add(handler)
      return () => { openedHandlers.delete(handler) }
    },
    getLayouts: async (): Promise<GetLayoutsResult | null> => null,
    getComments: async (): Promise<SlideComment[]> => [],
    getAnimations: async (): Promise<AnimationItem[]> => [],
    getShapeKeys: async (): Promise<ShapeKey[]> => [],
    getShowTiming: async (): Promise<ShowTiming> => ({advanceMs: null, narrationIds: []}),
    getHeaderFooter: async () => ({footer: null, slideNum: false, date: null}),
    getLink: async (): Promise<LinkTargetOp | null> => null,
    getSlideLinks: async () => <Array<{sourceId: string; target: LinkTargetOp}>>[],
    getRunLinks: async () => <Array<{sourceId: string; paraIndex: number; runIndex: number; target: LinkTargetOp}>>[],
    getChartData: async () => null, getChartColorSchemes: async () => null,
    skillsList: async () => <Array<{name: string; description: string; relevant: boolean}>>[],
    gskStatus: async () => ({available: false as const}),
    audienceReady: async () => null, audienceNav() {}, presenterSync() {}, presenterInk() {},
    // Format edits and structural selections beyond the T10 server whitelist stay explicit no-ops.
    editFill: graceful, editStroke: graceful, editBackground: graceful, editImageFill: graceful,
    editPictureSrcRect: graceful, editPictureOpacity: graceful, changeShape: graceful,
    setShapeAdjust: graceful, setShapeGeometry: graceful, setTextAnchor: graceful,
    setTextBodyProps: graceful, setEffects: graceful, editConnectorEndpoints: graceful,
    cancelTransformPreview: graceful, setSlideSize: graceful, setAnimations: gracefulFalse,
    setAdvanceTimes: gracefulFalse, saveRecording: graceful, clearNarration: graceful,
    setLink: graceful, addTable: graceful, addChart: graceful, addSmartArt: graceful,
    addInk: graceful, addImageBytes: graceful, replacePictureBytes: graceful,
    editTableCell: graceful, tableStructure: graceful, tableMerge: graceful,
    setTableColWidth: graceful, setTableRowHeight: graceful, setTableCellAnchor: graceful,
    editTableStyle: graceful, editChart: graceful, addComment: graceful, deleteComment: graceful,
    setSlidesHidden: graceful, deleteSlides: graceful, duplicateSlides: graceful, moveSlides: graceful,
    insertImageUrl: graceful, replacePictureUrl: graceful, applyTheme: graceful,
    flipElements: graceful,
    masterEnter: unavailable, masterOpen: unavailable, masterClose: unavailable,
    masterEditText: unavailable, masterEditTransform: unavailable, masterEditFill: unavailable,
    masterEditStroke: unavailable, masterDeleteElement: unavailable, masterAddElement: unavailable,
    presenterStart: unavailable, presenterSwap: unavailable, presenterEnd: unavailable,
    onShowSync: noEvent, onShowInk: noEvent, onAudienceNav: noEvent,
    openAiModelSettings: unavailable, openSkillsSettings: unavailable,
    skillText: unavailable, aiStream: unavailable, aiStreamCancel: async () => {},
    aiGskStatus: unavailable, aiGskLogin: unavailable, aiLogRunFailure: async () => {},
    webSearch: unavailable, imageSearch: unavailable, analyzeMedia: unavailable, generateImage: unavailable,
    saveStyleSidecar: unavailable, saveStyleTemplate: unavailable, listStyleTemplates: async () => <Array<{name: string; topic: string; createdAt: string}>>[], loadStyleTemplate: unavailable,
  } satisfies Partial<SlidesApi>

  async function confirmSave() {
    const pending = recovery
    if (!pending || confirming) return
    confirming = true
    try {
      const saved = await host.reconcileSlides(fileId)
      // Adopt the confirmed head and clear the tracked dirty flag: the parked
      // receipt fenced mutations, so nothing was edited between the export and
      // this confirmation; edits made afterwards take the normal path.
      if (session) { session.revision = saved.revision; session.dirty = false }
      recovery = null
      pending.resolve({ok: true, path: host.getState(fileId).name})
    } catch (error) {
      if (host.getState(fileId).status !== 'unknown') { recovery = null; pending.resolve({ok: false, error: text.saveFailed}) }
      throw error
    } finally { confirming = false; onChange() }
  }
  async function prepareDownload(editor: {saveAndWait(): Promise<boolean>; isDirty(): boolean}) {
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    const before = host.getState(fileId)
    if (!before.lease || before.status === 'unauthorized' || before.status === 'conflict') throw hostError('CONFLICT', 'download authority')
    // The renderer owns the active editor and its full save/late-edit cycle. Its
    // promise stays pending across an unknown commit receipt; never fall back to
    // a saved-head link on cancellation, conflict or remaining edits.
    if (!await editor.saveAndWait()) throw hostError('UNAVAILABLE', 'download save')
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    const state = host.getState(fileId)
    if (editor.isDirty() || recovery || state.status !== 'idle' || !state.lease) throw hostError('CONFLICT', 'download not clean')
    return {...state.revision}
  }
  async function takeover(editor: {reload(): Promise<boolean>; isDirty(): boolean}) {
    if (disposed) throw hostError('UNAVAILABLE', 'disposed')
    if (editor.isDirty() || recovery || host.getState(fileId).status === 'unknown') throw hostError('CONFLICT', 'unsaved takeover')
    let acquired = false
    try {
      await host.takeoverLease(fileId); acquired = true
      if (disposed || editor.isDirty() || recovery) throw hostError('CONFLICT', 'unsaved takeover')
      await host.refreshHead(fileId)
      if (disposed || editor.isDirty() || recovery) throw hostError('CONFLICT', 'unsaved takeover')
      if (!await editor.reload()) throw hostError('UNAVAILABLE', 'takeover reload')
      if (disposed || !host.getState(fileId).lease) throw hostError('CONFLICT', 'takeover authority')
    } catch (error) {
      // A failed reload must not expose a stale view as an editable new head.
      if (acquired) await host.releaseLease(fileId).catch(() => {})
      throw error
    }
  }
  return {
    api,
    confirmSave,
    prepareDownload,
    takeover,
    needsConfirmation: () => recovery !== null,
    isDirty: () => session?.dirty ?? false,
    dispose() {
      disposed = true
      recovery?.reject(hostError('UNAVAILABLE', 'disposed'))
      recovery = null
      for (const controller of controllers) controller.abort()
      controllers.clear()
      session = null
      pendingOpen = null
      historyHandlers.clear()
      openedHandlers.clear()
      notesBySlide.clear()
      transitions.clear()
      sections = []
      csrf = undefined
    },
  }
}
