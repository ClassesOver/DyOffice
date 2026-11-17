import { createSessionFileHost } from '../../../../../packages/browser-host/src/session-files.ts'
import { createHttpCommandClient } from '../../../../../packages/browser-host/src/http-commands.ts'
import { createToolExecutor } from '../../../../../packages/browser-host/src/tool-executor.ts'
import { createCommandSaveCoordinator } from '../../../../../packages/browser-host/src/command-save.ts'
import { importLibreOfficeTemplateDocx } from '../../../../../packages/browser-host/src/libreoffice-template-docx.ts'
import { isRevisionRef, type RevisionRef } from '../../../../../packages/web-contracts/src/api.ts'
import type { CommandEnvelope } from '../../../../../packages/web-contracts/src/tools.ts'
import { sameCommandJson } from '../../../../../packages/browser-host/src/command-equality.ts'
import { createDocumentMutationFence } from '../document-mutation-fence'
import { createControlledTextModel } from './controlled-text-model'
const key = 'dyoffice.t14.controlled.v1',
  profileVersion = 'lo-template-v1'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
type Pointer = { fileId: string; commandId: string; profileVersion: string }
type Phase =
  | 'initial'
  | 'opening'
  | 'validating'
  | 'acquiring'
  | 'ready'
  | 'proposing'
  | 'pending_approval'
  | 'approving'
  | 'approved'
  | 'applying'
  | 'applied_uncommitted'
  | 'saving'
  | 'verifying'
  | 'committed'
  | 'blocked'
  | 'recovery_required'
  | 'disposed'
type Candidate = { index: number; replacement: string; expectedText: string }
export interface ControlledTextSnapshot {
  phase: Phase
  message: string
  fileId: string
  base?: RevisionRef
  paragraphs: readonly string[]
  candidate?: Candidate
  proposal?: { commandId: string; digest: string }
  receipt?: RevisionRef
  recovery?: Pointer
}
type Dependencies = {
  pointerLocks: Pick<LockManager, 'request'> | undefined
  createHost: typeof createSessionFileHost
  createCommands: typeof createHttpCommandClient
  createModel: typeof createControlledTextModel
  importProfile: typeof importLibreOfficeTemplateDocx
}
/** Default-off composition. The testing seams are explicit local dependencies,
 * never globals; production callers leave them absent. No automatic retry,
 * takeover, inverse UI or clearing of an opaque recovery pointer. */
export function createControlledTextController({
  fileId,
  pointerStorage,
  getCsrfToken,
  fetchImpl = fetch,
  testing,
}: {
  fileId: string
  pointerStorage: Pick<Storage, 'getItem' | 'setItem'>
  getCsrfToken: () => Promise<string>
  fetchImpl?: typeof fetch
  testing?: Partial<Dependencies>
}) {
  if (!uuid.test(fileId)) throw Error('Invalid file identity')
  const deps: Dependencies = {
      pointerLocks: typeof navigator === 'undefined' ? undefined : navigator.locks,
      createHost: createSessionFileHost,
      createCommands: createHttpCommandClient,
      createModel: createControlledTextModel,
      importProfile: importLibreOfficeTemplateDocx,
      ...testing,
    },
    editorId = crypto.randomUUID(),
    host = deps.createHost({ editorId, fetchImpl }),
    fence = createDocumentMutationFence(),
    listeners = new Set<() => void>()
  let operationForSave = 0,
    phase: Phase = 'initial',
    message = '尚未打开',
    disposed = false,
    busy = false,
    epoch = 0,
    inApply = false,
    armed = false,
    pointerRead = false,
    base: RevisionRef | undefined,
    leaseEpoch = 0,
    candidate: Candidate | undefined,
    envelope: CommandEnvelope | undefined,
    digest: string | undefined,
    pointer: Pointer | undefined,
    receipt: RevisionRef | undefined,
    model: ReturnType<typeof createControlledTextModel> | undefined,
    profile: Awaited<ReturnType<typeof importLibreOfficeTemplateDocx>> | undefined,
    executor: ReturnType<typeof createToolExecutor> | undefined,
    coordinator: ReturnType<typeof createCommandSaveCoordinator> | undefined,
    serialized: Uint8Array | undefined,
    stopRenewal: (() => void) | undefined
  const emit = () => {
    for (const fn of listeners)
      try {
        fn()
      } catch {
        /* views cannot change controller result */
      }
  }
  function readPointer(): Pointer | undefined {
    const raw = pointerStorage.getItem(key)
    if (raw === null) return
    if (typeof raw !== 'string' || raw.length > 512) throw Error('Invalid recovery pointer')
    const p = JSON.parse(raw)
    if (
      !p ||
      Object.keys(p).sort().join() !== 'commandId,fileId,profileVersion' ||
      !uuid.test(p.fileId) ||
      !uuid.test(p.commandId) ||
      p.profileVersion !== profileVersion
    )
      throw Error('Invalid recovery pointer')
    return { fileId: p.fileId, commandId: p.commandId, profileVersion: p.profileVersion }
  }
  function pointerMatches() {
    if (pointerRead && !sameCommandJson(readPointer(), pointer))
      throw Error('Recovery pointer changed')
  }
  function liveHost(requireIdle = true) {
    if (!base) throw Error('No model authority')
    const s = host.getState(fileId)
    if (
      !s.lease ||
      s.lease.editorId !== editorId ||
      s.lease.leaseEpoch !== leaseEpoch ||
      Date.parse(s.lease.expiresAt) <= Date.now() ||
      !sameCommandJson(s.revision, base) ||
      (requireIdle && s.status !== 'idle')
    )
      throw Error('Live file authority changed')
    pointerMatches()
    return s
  }
  function guard(operation: number) {
    if (disposed || epoch !== operation) throw Error('Controller superseded')
    pointerMatches()
  }
  function fail(error: unknown) {
    if (disposed) return
    inApply = false
    stopRenewal?.()
    phase = pointer ? 'recovery_required' : 'blocked'
    message = pointer
      ? '结果未确认。保留恢复指针，只能查询或明确放弃；不会重放、夺租约或撤销。'
      : '无法继续，请重新核对文件、权限或本地存储。'
    emit()
  }
  async function run(allowed: Phase, next: Phase, fn: (operation: number) => Promise<void>) {
    if (disposed || busy || phase !== allowed) throw Error('Action unavailable')
    busy = true
    const operation = ++epoch
    phase = next
    emit()
    try {
      guard(operation)
      await fn(operation)
      guard(operation)
    } catch (error) {
      if (allowed === 'initial' && !model && !pointer && leaseEpoch > 0) {
        try {
          void host.releaseLease(fileId).catch(() => {})
        } catch {
          /* best effort, not cancellation evidence */
        }
      }
      fail(error)
      throw error
    } finally {
      busy = false
      emit()
    }
  }
  const commands = deps.createCommands({
    editorId,
    currentGeneration: () => model?.current().editorGeneration ?? 0,
    getCsrfToken,
    fetchImpl,
  })
  const unsubscribe = host.subscribe(() => {
    if (
      !armed ||
      disposed ||
      phase === 'committed' ||
      phase === 'recovery_required' ||
      phase === 'blocked'
    )
      return
    try {
      const s = host.getState(fileId)
      if (
        !s.lease ||
        s.lease.leaseEpoch !== leaseEpoch ||
        s.lease.editorId !== editorId ||
        ['conflict', 'unauthorized', 'unknown'].includes(s.status) ||
        (!['saving', 'verifying'].includes(phase) && !sameCommandJson(s.revision, base))
      )
        throw Error('Host authority changed')
    } catch (error) {
      epoch++
      fail(error)
    }
  })
  return Object.freeze({
    snapshot(): ControlledTextSnapshot {
      return {
        phase,
        message,
        fileId,
        ...(base ? { base: { ...base } } : {}),
        paragraphs: model && !disposed ? [...model.paragraphs()] : [],
        ...(candidate ? { candidate: { ...candidate } } : {}),
        ...(envelope && digest ? { proposal: { commandId: envelope.commandId, digest } } : {}),
        ...(receipt ? { receipt: { ...receipt } } : {}),
        ...(pointer ? { recovery: { ...pointer } } : {}),
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open() {
      return run('initial', 'opening', async (operation) => {
        pointer = readPointer()
        pointerRead = true
        if (pointer) {
          phase = pointer.fileId === fileId ? 'recovery_required' : 'blocked'
          message = '发现恢复指针。先查询原命令，不会自动重新提交或夺取租约。'
          return
        }
        const opened = await host.open(fileId)
        guard(operation)
        if (
          opened.format !== 'docx' ||
          !isRevisionRef(opened.file) ||
          opened.file.fileId !== fileId
        )
          throw Error('Unsupported file')
        base = { ...opened.file }
        const bytes = await host.readBytes(fileId, base.revision)
        guard(operation)
        phase = 'validating'
        emit()
        profile = await deps.importProfile(new Uint8Array(bytes))
        guard(operation)
        const texts = profile.paragraphs
        if (
          texts.length < 1 ||
          texts.length > 256 ||
          texts.some(
            (s) =>
              typeof s !== 'string' ||
              s.length < 1 ||
              s.length > 32768 ||
              /[\u0000-\u001f\u007f-\u009f]/.test(s) ||
              /[\uD800-\uDFFF]/u.test(s),
          ) ||
          texts.reduce((n, s) => n + new TextEncoder().encode(s).byteLength, 0) > 1048576
        )
          throw Error('Profile exceeds native model bounds')
        if (!deps.pointerLocks || typeof deps.pointerLocks.request !== 'function')
          throw Error('Web Locks required for recovery pointer safety')
        phase = 'acquiring'
        emit()
        const lease = await host.acquireLease(fileId)
        guard(operation)
        leaseEpoch = lease.leaseEpoch
        const head = await host.refreshHead(fileId)
        guard(operation)
        if (!sameCommandJson(head, base)) throw Error('File changed during capability validation')
        model = deps.createModel({
          paragraphs: profile.paragraphs,
          authority: () => ({ fileId, baseRevision: base!.revision, leaseEpoch }),
          canWrite: () => {
            try {
              if (disposed || !inApply || phase !== 'applying' || !fence.snapshot().ready)
                return false
              liveHost()
              return true
            } catch {
              return false
            }
          },
          mutationFence: fence,
        })
        executor = createToolExecutor({
          journal: commands,
          editor: {
            current: () => model!.current(),
            applyBatch(e) {
              liveHost()
              inApply = true
              try {
                return model!.tools.applyBatch(e)
              } finally {
                inApply = false
              }
            },
            undoBatch() {
              throw Error('Undo unavailable in this composition')
            },
          },
        })
        coordinator = createCommandSaveCoordinator({
          host: {
            stageSave: async (bytes, id) => {
              guard(operationForSave)
              if (phase !== 'saving') throw Error('Save closed')
              liveHost(false)
              const result = await host.stageSave(bytes, id)
              guard(operationForSave)
              return result
            },
            commitSave: async (input) => {
              guard(operationForSave)
              if (phase !== 'saving') throw Error('Save closed')
              liveHost(false)
              const result = await host.commitSave(input)
              guard(operationForSave)
              return result
            },
            reconcile: async () => {
              throw Error('Fresh recovery required; commit replay disabled')
            },
          },
          current: () => {
            if (disposed || phase !== 'saving') throw Error('Save closed')
            liveHost(false)
            return model!.current()
          },
          serialize: async () => {
            const generation = model!.current().editorGeneration,
              values = model!.paragraphs(),
              output = await profile!.export(values)
            guard(operationForSave)
            if (generation !== model!.current().editorGeneration)
              throw Error('Model changed during export')
            serialized = new Uint8Array(output)
            return new Uint8Array(serialized)
          },
          bind: async (b) => {
            guard(operationForSave)
            if (phase !== 'saving') throw Error('Save closed')
            liveHost(false)
            const bound = await commands.bindCommandUpload(envelope!, b)
            guard(operationForSave)
            if (phase !== 'saving') throw Error('Save closed')
            return bound
          },
          verifyCommitted: (e, r, d) => commands.verifyCommitted(e, r, d),
        })
        armed = true
        stopRenewal = host.startRenewal(fileId)
        liveHost()
        phase = 'ready'
        message = '仅支持已验证模板的整段文本替换，非所见即所得编辑器。'
      })
    },
    setCandidate(index: number, replacement: string) {
      if (disposed || busy || phase !== 'ready' || !model) throw Error('Candidate unavailable')
      try {
        liveHost()
      } catch (error) {
        fail(error)
        throw error
      }
      const values = model.paragraphs()
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= values.length ||
        typeof replacement !== 'string' ||
        replacement.length > 32768 ||
        replacement === values[index]
      )
        throw Error('Invalid replacement')
      candidate = { index, replacement, expectedText: values[index] }
      emit()
    },
    propose() {
      return run('ready', 'proposing', async (operation) => {
        if (!candidate || !model || !profile || !base) throw Error('No candidate')
        liveHost()
        const chosen = { ...candidate },
          values = [...model.paragraphs()],
          generation = model.current().editorGeneration
        values[chosen.index] = chosen.replacement
        await profile.export(values)
        guard(operation)
        liveHost()
        if (model.current().editorGeneration !== generation) throw Error('Model changed')
        const from =
            1 +
            model
              .paragraphs()
              .slice(0, chosen.index)
              .reduce((n, s) => n + s.length + 2, 0),
          args = {
            expectedText: chosen.expectedText,
            from,
            replacement: chosen.replacement,
            to: from + chosen.expectedText.length,
          },
          argsHash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(args))),
            ),
            (n) => n.toString(16).padStart(2, '0'),
          ).join('')
        guard(operation)
        liveHost()
        envelope = {
          commandId: crypto.randomUUID(),
          ...model.current(),
          argsHash,
          payload: { toolName: 'docs.replace_text.v1', arguments: args },
        }
        if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 65536)
          throw Error('Command envelope exceeds server bound')
        await deps.pointerLocks!.request(key, { mode: 'exclusive' }, () => {
          guard(operation)
          liveHost()
          if (readPointer()) throw Error('Another recovery pointer exists')
          pointer = { fileId, commandId: envelope!.commandId, profileVersion }
          pointerStorage.setItem(key, JSON.stringify(pointer))
          guard(operation)
        })
        guard(operation)
        const proposal = await commands.proposeCommand(envelope)
        guard(operation)
        if (proposal.state !== 'pending_approval') throw Error('Unexpected proposal state')
        digest = proposal.digest
        phase = 'pending_approval'
        message = '请核对文件、版本和整段原文/替换内容，明确批准后才能执行。'
      })
    },
    approve() {
      return run('pending_approval', 'approving', async (operation) => {
        liveHost()
        const result = await commands.approveCommand(envelope!, digest!)
        guard(operation)
        if (result.state !== 'approved') throw Error('Approval unconfirmed')
        phase = 'approved'
        message = '已批准，尚未执行。'
      })
    },
    apply() {
      return run('approved', 'applying', async (operation) => {
        liveHost()
        const result = await executor!.executeAuthorizedTool(envelope!, digest!)
        guard(operation)
        if (result.status !== 'applied_uncommitted') throw Error('Local effect unconfirmed')
        phase = 'applied_uncommitted'
        message = '已应用到本地受控模型，尚未保存。'
      })
    },
    save() {
      return run('applied_uncommitted', 'saving', async (operation) => {
        operationForSave = operation
        liveHost()
        const expected = [...model!.paragraphs()],
          saved = await coordinator!.save(envelope!, digest!, model!.current().editorGeneration)
        guard(operation)
        phase = 'verifying'
        message = '保存收据已确认，正在核对实际存储内容。'
        emit()
        const bytes = await host.readBytes(fileId, saved.revision)
        guard(operation)
        if (
          !serialized ||
          bytes.byteLength !== serialized.byteLength ||
          !bytes.every((v, i) => v === serialized![i])
        )
          throw Error('Stored bytes differ')
        const reopened = await deps.importProfile(new Uint8Array(bytes))
        guard(operation)
        if (!sameCommandJson(reopened.paragraphs, expected)) throw Error('Stored paragraphs differ')
        receipt = { ...saved }
        phase = 'committed'
        try {
          stopRenewal?.()
        } catch {
          /* verified commit is not undone by timer cleanup */
        }
        message = '已验证原命令保存收据和实际存储内容。恢复指针保留，返回后只查询此命令。'
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      epoch++
      inApply = false
      phase = 'disposed'
      message = '页面已关闭；已发请求可能继续生效。'
      stopRenewal?.()
      unsubscribe()
      executor?.dispose()
      coordinator?.dispose()
      commands.dispose()
      model?.dispose()
      fence.dispose()
      try {
        void host.releaseLease(fileId, true).catch(() => {})
      } catch {
        /* best effort only */
      }
      host.dispose()
      emit()
      listeners.clear()
    },
  })
}
