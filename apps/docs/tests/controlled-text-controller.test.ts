import { afterEach, expect, test, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createControlledTextController } from '../src/renderer/editor/controlled-text-controller'
const fileId = '11111111-1111-4111-8111-111111111111',
  revision = '22222222-2222-4222-8222-222222222222'
let cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.forEach((f) => f())
  cleanup = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function fixture(
  storage: Storage = sessionStorage,
  targetFileId = fileId,
  pointerLocks: any = { request: async (_name: any, _options: any, fn: any) => fn() },
) {
  vi.stubGlobal('crypto', webcrypto)
  storage.clear()
  let generation = 0,
    paragraphs = ['hello'],
    writable: () => boolean = () => false
  const calls: string[] = [],
    stopped = vi.fn()
  let eid = '',
    lease: any = null,
    ref = { fileId: targetFileId, revision, sha256: 'a'.repeat(64), size: 1 },
    status = 'idle',
    notify = () => {}
  const host: any = {
    open: vi.fn(async () => {
      calls.push('open')
      return { file: ref, format: 'docx' }
    }),
    readBytes: vi.fn(async () => new Uint8Array([ref.revision === revision ? 1 : 2])),
    acquireLease: vi.fn(
      async () =>
        (lease = {
          editorId: eid,
          leaseEpoch: 1,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
    ),
    refreshHead: vi.fn(async () => ref),
    getState: () => ({ revision: ref, lease, status }),
    subscribe: (fn: () => void) => {
      notify = fn
      return () => {}
    },
    stageSave: vi.fn(async () => ({ uploadId: '33333333-3333-4333-8333-333333333333' })),
    commitSave: vi.fn(async () => {
      status = 'saving'
      notify()
      const hash = Array.from(
        new Uint8Array(await webcrypto.subtle.digest('SHA-256', new Uint8Array([2]))),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('')
      ref = { fileId, revision: '44444444-4444-4444-8444-444444444444', sha256: hash, size: 1 }
      status = 'idle'
      notify()
      return ref
    }),
    reconcile: vi.fn(async () => {
      throw Error('not exposed')
    }),
    startRenewal: () => stopped,
    releaseLease: vi.fn(async () => {
      lease = null
    }),
    dispose: vi.fn(),
  }
  const client: any = {
    proposeCommand: vi.fn(async (e: any) => {
      calls.push('propose')
      return { envelope: e, digest: 'b'.repeat(64), state: 'pending_approval' }
    }),
    approveCommand: vi.fn(async (e: any) => ({
      envelope: e,
      digest: 'b'.repeat(64),
      state: 'approved',
    })),
    beginExecution: vi.fn(async (e: any) => {
      expect(writable()).toBe(false)
      return { envelope: e, claimId: 'claim' }
    }),
    reportApplied: vi.fn(async () => {}),
    bindCommandUpload: vi.fn(async () => ({ bound: true })),
    verifyCommitted: vi.fn(async () => true),
    dispose: vi.fn(),
  }
  const importProfile = vi.fn(async (bytes: Uint8Array) => ({
    paragraphs: bytes[0] === 1 ? ['hello'] : [...paragraphs],
    export: async () => new Uint8Array([2]),
  }))
  const controller = createControlledTextController({
    fileId: targetFileId,
    pointerStorage: storage,
    getCsrfToken: async () => 'c'.repeat(43),
    testing: {
      pointerLocks,
      createHost: (o: any) => {
        eid = o.editorId
        return host
      },
      createCommands: () => client,
      importProfile,
      createModel: (options: any) => {
        writable = options.canWrite
        const current = () => ({ ...options.authority(), editorGeneration: generation })
        return {
          current,
          paragraphs: () => paragraphs,
          dispose() {},
          tools: {
            current,
            applyBatch(e: any) {
              expect(writable()).toBe(true)
              generation++
              paragraphs = [e.payload.arguments.replacement]
              return { generation, undoToken: {} }
            },
            undoBatch() {
              throw Error('disabled')
            },
          },
        } as any
      },
    },
  })
  cleanup.push(() => controller.dispose())
  return {
    controller,
    stopped,
    host,
    client,
    calls,
    importProfile,
    changeHost: (next: string) => {
      status = next
      notify()
    },
  }
}
test('pointer read-back precedes proposal and apply only opens synchronous model gate', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  await f.controller.propose()
  expect(sessionStorage.length).toBe(1)
  await f.controller.approve()
  await f.controller.apply()
  expect(f.controller.snapshot().phase).toBe('applied_uncommitted')
  expect(f.client.beginExecution).toHaveBeenCalledTimes(1)
  expect(() => f.controller.setCandidate(0, 'again')).toThrow()
})
test('existing pointer prevents open acquire and automatic re-proposal', async () => {
  const f = fixture()
  sessionStorage.setItem(
    'dyoffice.t14.controlled.v1',
    JSON.stringify({ fileId, commandId: revision, profileVersion: 'lo-template-v1' }),
  )
  await f.controller.open()
  expect(f.controller.snapshot().phase).toBe('recovery_required')
  expect(f.host.open).not.toHaveBeenCalled()
  expect(f.host.acquireLease).not.toHaveBeenCalled()
  expect(f.client.proposeCommand).not.toHaveBeenCalled()
})
test('failed pointer persistence sends no proposal', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('storage full')
  })
  try {
    await expect(f.controller.propose()).rejects.toThrow()
    expect(f.client.proposeCommand).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})
test('lost proposal retains pointer and cannot retry or acquire again', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  f.client.proposeCommand.mockRejectedValue(Error('lost'))
  await expect(f.controller.propose()).rejects.toThrow()
  expect(f.controller.snapshot().phase).toBe('recovery_required')
  expect(sessionStorage.length).toBe(1)
  await expect(f.controller.propose()).rejects.toThrow()
  expect(f.client.proposeCommand).toHaveBeenCalledTimes(1)
})
test('dispose during open fences late response and never acquires', async () => {
  const f = fixture()
  let resolve: (v: any) => void
  f.host.open.mockReturnValue(new Promise((r) => (resolve = r)))
  const pending = f.controller.open()
  f.controller.dispose()
  resolve!({ file: { fileId, revision, sha256: 'a'.repeat(64), size: 1 }, format: 'docx' })
  await expect(pending).rejects.toThrow()
  expect(f.host.acquireLease).not.toHaveBeenCalled()
  expect(f.controller.snapshot().phase).toBe('disposed')
})
test('duplicate approval is rejected while first request is pending', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  await f.controller.propose()
  let resolve: (v: any) => void
  f.client.approveCommand.mockImplementation(
    (e: any) =>
      new Promise((r) => {
        resolve = () => r({ envelope: e, digest: 'b'.repeat(64), state: 'approved' })
      }),
  )
  const p = f.controller.approve()
  await expect(f.controller.approve()).rejects.toThrow()
  resolve!(null)
  await p
  expect(f.client.approveCommand).toHaveBeenCalledTimes(1)
})

for (const bad of ['invalid-json', 'getter-error', 'other-file'])
  test('pointer ' + bad + ' cannot become an empty writable session', async () => {
    const f = fixture()
    if (bad === 'getter-error')
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw Error('unavailable')
      })
    else
      sessionStorage.setItem(
        'dyoffice.t14.controlled.v1',
        bad === 'invalid-json'
          ? '{'
          : JSON.stringify({
              fileId: revision,
              commandId: revision,
              profileVersion: 'lo-template-v1',
            }),
      )
    if (bad === 'other-file') await f.controller.open()
    else await expect(f.controller.open()).rejects.toThrow()
    expect(f.controller.snapshot().phase).toBe('blocked')
    expect(f.host.open).not.toHaveBeenCalled()
    expect(f.host.acquireLease).not.toHaveBeenCalled()
  })
test('head change after acquire stops instead of changing the base', async () => {
  const f = fixture()
  f.host.refreshHead.mockResolvedValue({
    fileId,
    revision: '55555555-5555-4555-8555-555555555555',
    sha256: 'c'.repeat(64),
    size: 1,
  })
  await expect(f.controller.open()).rejects.toThrow()
  expect(f.controller.snapshot().phase).toBe('blocked')
  expect(f.controller.snapshot().base?.revision).toBe(revision)
  expect(f.client.proposeCommand).not.toHaveBeenCalled()
})
test('model input bounds reject before acquiring a lease', async () => {
  const f = fixture()
  f.importProfile.mockResolvedValue({
    paragraphs: ['x'.repeat(32769)],
    export: async () => new Uint8Array([2]),
  })
  await expect(f.controller.open()).rejects.toThrow()
  expect(f.host.acquireLease).not.toHaveBeenCalled()
})
test('host conflict stays closed even if later renewal emits idle', async () => {
  const f = fixture()
  await f.controller.open()
  f.changeHost('conflict')
  expect(f.controller.snapshot().phase).toBe('blocked')
  f.changeHost('idle')
  expect(f.controller.snapshot().phase).toBe('blocked')
  expect(() => f.controller.setCandidate(0, 'world')).toThrow()
})
test('save validates actual serialized bytes and retains pointer after verified terminal state', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  await f.controller.propose()
  await f.controller.approve()
  await f.controller.apply()
  await f.controller.save()
  expect(f.controller.snapshot().phase).toBe('committed')
  expect(f.controller.snapshot().receipt?.revision).not.toBe(revision)
  expect(f.host.commitSave).toHaveBeenCalledTimes(1)
  expect(f.client.verifyCommitted).toHaveBeenCalledTimes(1)
  expect(sessionStorage.length).toBe(1)
  expect(f.host.reconcile).not.toHaveBeenCalled()
  expect(f.stopped).toHaveBeenCalledTimes(1)
})
test('unconfirmed save cannot repeat stage commit or reconcile', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  await f.controller.propose()
  await f.controller.approve()
  await f.controller.apply()
  f.host.commitSave.mockRejectedValue(Error('lost'))
  await expect(f.controller.save()).rejects.toThrow()
  expect(f.controller.snapshot().phase).toBe('recovery_required')
  await expect(f.controller.save()).rejects.toThrow()
  expect(f.host.commitSave).toHaveBeenCalledTimes(1)
  expect(f.host.stageSave).toHaveBeenCalledTimes(1)
  expect(f.host.reconcile).not.toHaveBeenCalled()
  expect(sessionStorage.length).toBe(1)
})

test('pointer write without matching read-back sends no request', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
  await expect(f.controller.propose()).rejects.toThrow()
  expect(f.client.proposeCommand).not.toHaveBeenCalled()
  expect(f.controller.snapshot().phase).toBe('recovery_required')
})
test('new pointer appearing while open awaits prevents lease acquisition', async () => {
  const f = fixture()
  let resolve: (v: any) => void
  f.host.open.mockReturnValue(new Promise((r) => (resolve = r)))
  const p = f.controller.open()
  sessionStorage.setItem(
    'dyoffice.t14.controlled.v1',
    JSON.stringify({ fileId, commandId: revision, profileVersion: 'lo-template-v1' }),
  )
  resolve!({ file: { fileId, revision, sha256: 'a'.repeat(64), size: 1 }, format: 'docx' })
  await expect(p).rejects.toThrow()
  expect(f.host.acquireLease).not.toHaveBeenCalled()
  expect(sessionStorage.length).toBe(1)
})
test('UTF8 command envelope is bounded before pointer or proposal', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, '界'.repeat(24000))
  await expect(f.controller.propose()).rejects.toThrow(/bound/)
  expect(f.client.proposeCommand).not.toHaveBeenCalled()
  expect(sessionStorage.length).toBe(0)
})
test('dispose while approval waits cannot restore approved phase', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  await f.controller.propose()
  let resolve: (v: any) => void
  f.client.approveCommand.mockReturnValue(new Promise((r) => (resolve = r)))
  const p = f.controller.approve()
  f.controller.dispose()
  resolve!({ state: 'approved' })
  await expect(p).rejects.toThrow()
  expect(f.controller.snapshot().phase).toBe('disposed')
  expect(sessionStorage.length).toBe(1)
})
test('stored-byte mismatch after receipt does not claim completed save', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  await f.controller.propose()
  await f.controller.approve()
  await f.controller.apply()
  f.host.readBytes.mockResolvedValue(new Uint8Array([3]))
  await expect(f.controller.save()).rejects.toThrow(/bytes/)
  expect(f.controller.snapshot().phase).toBe('recovery_required')
  expect(f.controller.snapshot().receipt).toBeUndefined()
  expect(sessionStorage.length).toBe(1)
})

test('another writer pointer appearing in ready phase closes model before candidate editing', async () => {
  const f = fixture()
  await f.controller.open()
  sessionStorage.setItem(
    'dyoffice.t14.controlled.v1',
    JSON.stringify({ fileId, commandId: revision, profileVersion: 'lo-template-v1' }),
  )
  expect(() => f.controller.setCandidate(0, 'world')).toThrow()
  expect(f.controller.snapshot().phase).toBe('blocked')
  expect(f.client.proposeCommand).not.toHaveBeenCalled()
  expect(sessionStorage.length).toBe(1)
})

test('opaque pointer is written only inside an exclusive origin lock', async () => {
  let held = false
  const locks = {
    request: vi.fn(async (_name: any, options: any, fn: any) => {
      expect(options.mode).toBe('exclusive')
      held = true
      try {
        return await fn()
      } finally {
        held = false
      }
    }),
  }
  const f = fixture(sessionStorage, fileId, locks)
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  const original = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k, v) {
    expect(held).toBe(true)
    return original.call(this, k, v)
  })
  await f.controller.propose()
  expect(locks.request).toHaveBeenCalledTimes(1)
})
test('missing Web Locks fails closed before acquiring lease', async () => {
  const f = fixture(sessionStorage, fileId, null)
  await expect(f.controller.open()).rejects.toThrow(/lock/i)
  expect(f.host.acquireLease).not.toHaveBeenCalled()
})
test('two different-file controllers cannot replace the first durable recovery pointer', async () => {
  let release!: () => void
  let tail = new Promise<void>((resolve) => { release = resolve })
  let queued = 0
  const locks = {
    request: vi.fn((_name: any, _options: any, fn: any) => {
      const p = tail.then(fn)
      if (++queued === 2) release()
      tail = p.catch(() => {})
      return p
    }),
  }
  const a = fixture(sessionStorage, fileId, locks),
    b = fixture(sessionStorage, '66666666-6666-4666-8666-666666666666', locks)
  await Promise.all([a.controller.open(), b.controller.open()])
  a.controller.setCandidate(0, 'world')
  b.controller.setCandidate(0, 'other')
  const results = await Promise.allSettled([a.controller.propose(), b.controller.propose()])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(
    a.client.proposeCommand.mock.calls.length + b.client.proposeCommand.mock.calls.length,
  ).toBe(1)
  const stored = JSON.parse(sessionStorage.getItem('dyoffice.t14.controlled.v1')!)
  const winner = a.client.proposeCommand.mock.calls.length ? a : b
  expect(stored.commandId).toBe(winner.client.proposeCommand.mock.calls[0][0].commandId)
  expect(locks.request).toHaveBeenCalledTimes(2)
})
test('authority loss while binding prevents any later commit request', async () => {
  const f = fixture()
  await f.controller.open()
  f.controller.setCandidate(0, 'world')
  await f.controller.propose()
  await f.controller.approve()
  await f.controller.apply()
  f.client.bindCommandUpload.mockImplementation(async () => {
    f.changeHost('conflict')
    return { bound: true }
  })
  await expect(f.controller.save()).rejects.toThrow()
  expect(f.host.commitSave).not.toHaveBeenCalled()
  expect(f.controller.snapshot().phase).toBe('recovery_required')
  expect(sessionStorage.length).toBe(1)
})
