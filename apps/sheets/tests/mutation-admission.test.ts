import { describe, expect, it, vi } from 'vitest'
import { CommandType } from '@univerjs/core'
import {
  admitMutation,
  blocksSaveWrite,
  installMutationInputAdmission,
  mutationAdmission,
} from '../src/renderer/mutation-admission'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('reinstall save mutation admission', () => {
  it('blocks user input in a body portal during freeze and reports the saving state', () => {
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (name: string, listener: EventListenerOrEventListenerObject) =>
        listeners.set(name, listener as (event: Event) => void),
      removeEventListener: (name: string) => listeners.delete(name),
    }
    const message = vi.fn()
    const dispose = installMutationInputAdmission(target, () => true, message)
    const event = new Event('click', { cancelable: true })
    listeners.get('click')?.(event)
    expect(event.defaultPrevented).toBe(true)
    expect(message).toHaveBeenCalledWith(expect.stringMatching(/saving/i))
    dispose()
    expect(listeners.size).toBe(0)
  })

  it('allows only explicit save-decision controls while workbook inputs remain frozen', () => {
    const listeners = new Map<string, (event: Event) => void>()
    const target = {
      addEventListener: (name: string, listener: EventListenerOrEventListenerObject) =>
        listeners.set(name, listener as (event: Event) => void),
      removeEventListener: (name: string) => listeners.delete(name),
    }
    const message = vi.fn()
    const dispose = installMutationInputAdmission(target, () => true, message)
    const control = (allow: string) => ({
      getAttribute: (name: string) => name === 'data-save-fence-allow' ? allow : null,
    })
    const allowed = control('confirm')
    for (const type of ['pointerdown', 'click', 'keydown']) {
      const event = new Event(type, { cancelable: true })
      Object.defineProperty(event, 'composedPath', { value: () => [{}, allowed] })
      listeners.get(type)?.(event)
      expect(event.defaultPrevented).toBe(false)
    }
    const wrongAllow = new Event('click', { cancelable: true })
    Object.defineProperty(wrongAllow, 'composedPath', { value: () => [control('edit')] })
    listeners.get('click')?.(wrongAllow)
    expect(wrongAllow.defaultPrevented).toBe(true)
    for (const type of ['input', 'paste', 'drop', 'submit']) {
      const event = new Event(type, { cancelable: true })
      Object.defineProperty(event, 'composedPath', { value: () => [allowed] })
      listeners.get(type)?.(event)
      expect(event.defaultPrevented).toBe(true)
    }
    const unrelated = new Event('click', { cancelable: true })
    Object.defineProperty(unrelated, 'composedPath', { value: () => [{ getAttribute: () => 'edit' }] })
    listeners.get('click')?.(unrelated)
    expect(unrelated.defaultPrevented).toBe(true)
    dispose()
  })

  it('blocks both command and direct mutation writes while allowing imports/formula results/view operations', () => {
    expect(blocksSaveWrite('frozen', CommandType.COMMAND, false, false)).toBe(true)
    expect(blocksSaveWrite('frozen', CommandType.MUTATION, false, false)).toBe(true)
    expect(blocksSaveWrite('frozen', CommandType.OPERATION, false, false)).toBe(false)
    expect(blocksSaveWrite('frozen', CommandType.MUTATION, true, false)).toBe(false)
    expect(blocksSaveWrite('frozen', CommandType.MUTATION, false, true)).toBe(false)
    expect(blocksSaveWrite('open', CommandType.COMMAND, false, false)).toBe(false)
  })

  it('closes admission synchronously, drains existing work before freezing, and releases', async () => {
    const gate = mutationAdmission({})
    const pending = deferred()
    const writes: string[] = []
    const task = gate.run(async () => {
      await pending.promise
      gate.assertWritable()
      writes.push('chart')
    })
    const lock = gate.close()
    expect(gate.phase).toBe('draining')
    expect(() =>
      gate.run(async () => {
        writes.push('new')
      }),
    ).toThrow(/saving/i)
    let frozen = false
    const drain = lock.freeze().then(() => {
      frozen = true
    })
    await Promise.resolve()
    expect(frozen).toBe(false)
    pending.resolve()
    await task
    await drain
    expect(writes).toEqual(['chart'])
    expect(gate.phase).toBe('frozen')
    expect(() => gate.assertWritable()).toThrow(/saving/i)
    lock.release()
    expect(gate.phase).toBe('open')
    gate.assertWritable()
  })

  it('allows an admitted note task to start its child apply without reopening admission', async () => {
    const gate = mutationAdmission({})
    const pending = deferred()
    const task = gate.run(async (lease) => {
      await pending.promise
      await gate.run(async () => {
        gate.assertWritable()
      }, lease)
    })
    const lock = gate.close()
    const drain = lock.freeze()
    pending.resolve()
    await task
    await drain
    lock.release()
  })

  it('rejects a new synchronous write while an admitted task is still draining', async () => {
    const workbook = {}
    const gate = mutationAdmission(workbook)
    const pending = deferred()
    const task = gate.run(async () => {
      await pending.promise
    })
    const lock = gate.close()
    const message = vi.fn()
    expect(admitMutation(workbook, message)).toBe(false)
    expect(message).toHaveBeenCalledWith(expect.stringMatching(/saving/i))
    pending.resolve()
    await task
    await lock.freeze()
    lock.release()
  })

  it('bounds a stuck task and still releases the lock', async () => {
    vi.useFakeTimers()
    try {
      const gate = mutationAdmission({})
      void gate.run(async () => await new Promise<void>(() => {}))
      const lock = gate.close(20)
      const draining = expect(lock.freeze()).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(25)
      await draining
      lock.release()
      expect(gate.phase).toBe('open')
    } finally {
      vi.useRealTimers()
    }
  })

  it('failed tasks do not poison draining and finally releases a failed save', async () => {
    const gate = mutationAdmission({})
    const pending = deferred()
    const task = gate.run(async () => {
      await pending.promise
      throw new Error('read failed')
    })
    const observed = task.catch(() => undefined)
    const lock = gate.close()
    try {
      const drain = lock.freeze()
      pending.resolve()
      await observed
      await drain
      throw new Error('save failed')
    } catch {
      /* save reports the failure */
    } finally {
      lock.release()
    }
    expect(gate.phase).toBe('open')
    await expect(gate.run(async () => 42)).resolves.toBe(42)
  })
})
