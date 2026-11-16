import { CommandType } from '@univerjs/core'
/** Per-workbook admission, separate from the save queue: draining never waits
 * for a save, only mutation tasks that registered before admission closed. */
export function blocksSaveWrite(
  phase: MutationPhase,
  type: number | undefined,
  importing: boolean,
  fromFormula: boolean,
): boolean {
  // OPERATIONS remain available for view.
  return (
    phase === 'frozen' &&
    !importing &&
    !fromFormula &&
    (type === CommandType.COMMAND || type === CommandType.MUTATION)
  )
}
export type MutationPhase = 'open' | 'draining' | 'frozen'
export const MUTATION_SAVE_MESSAGE =
  'Saving workbook structure. Please wait until saving finishes before editing.'
export interface MutationLease {
  readonly owner: MutationAdmission
  active: boolean
}
export interface MutationLock {
  drain(): Promise<void>
  flush(action: () => void | Promise<void>): Promise<void>
  freeze(): Promise<void>
  release(): void
}
export class MutationAdmission {
  phase: MutationPhase = 'open'
  private tasks = new Set<Promise<unknown>>()
  private listeners = new Set<(phase: MutationPhase) => void>()

  subscribe(listener: (phase: MutationPhase) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private setPhase(phase: MutationPhase): void {
    this.phase = phase
    for (const listener of this.listeners) listener(phase)
  }
  assertAdmitted(lease?: MutationLease): void {
    if (
      this.phase !== 'open' &&
      !(this.phase === 'draining' && lease?.owner === this && lease.active)
    ) {
      throw new Error(MUTATION_SAVE_MESSAGE)
    }
  }
  get activeTasks(): number {
    return this.tasks.size
  }
  assertWritable(): void {
    if (this.phase === 'frozen' || (this.phase === 'draining' && this.tasks.size === 0))
      throw new Error(MUTATION_SAVE_MESSAGE)
  }
  run<T>(action: (lease: MutationLease) => T | Promise<T>, parent?: MutationLease): Promise<T> {
    this.assertAdmitted(parent)
    const lease: MutationLease = { owner: this, active: true }
    // Register before invoking: even a synchronous close inside action sees it.
    let finish!: () => void
    const marker = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.tasks.add(marker)
    return (async () => {
      try {
        return await action(lease)
      } finally {
        lease.active = false
        this.tasks.delete(marker)
        finish()
      }
    })()
  }
  close(timeoutMs = 30_000): MutationLock {
    this.assertAdmitted()
    this.setPhase('draining')
    let released = false
    const deadline = Date.now() + timeoutMs
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    'Saving timed out waiting for pending workbook changes. Your draft is retained; try saving again.',
                  ),
                ),
              Math.max(0, deadline - Date.now()),
            )
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    const drain = async () => {
      while (this.tasks.size > 0) await bounded(Promise.all([...this.tasks]))
    }
    return {
      drain,
      flush: async (action) => {
        if (released || this.phase !== 'draining') throw new Error(MUTATION_SAVE_MESSAGE)
        const lease: MutationLease = { owner: this, active: true }
        try {
          await bounded(this.run(action, lease))
        } finally {
          lease.active = false
        }
      },
      freeze: async () => {
        await drain()
        if (!released) this.setPhase('frozen')
      },
      release: () => {
        if (released) return
        released = true
        this.setPhase('open')
      },
    }
  }
}
const gates = new WeakMap<object, MutationAdmission>()
export function mutationAdmission(workbook: object): MutationAdmission {
  let gate = gates.get(workbook)
  if (!gate) {
    gate = new MutationAdmission()
    gates.set(workbook, gate)
  }
  return gate
}
/** Synchronous action boundary (also used by body portals). */
export function admitMutation(
  workbook: object | null | undefined,
  message?: (text: string) => void,
): boolean {
  if (!workbook) return true
  try {
    mutationAdmission(workbook).assertAdmitted()
    return true
  } catch {
    message?.(MUTATION_SAVE_MESSAGE)
    return false
  }
}

/** Capture on Document, so React portals mounted outside the app root are gated
 * too. A write barrier and async drain are still required for admitted work. */
export function installMutationInputAdmission(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  blocked: () => boolean,
  message: (text: string) => void,
): () => void {
  const block = (event: Event) => {
    if (!blocked()) return
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const allowed = path.some((value) =>
      value && typeof (value as { getAttribute?: unknown }).getAttribute === 'function' &&
      (value as Element).getAttribute('data-save-fence-allow') === 'confirm',
    )
    if (allowed && (event.type === 'pointerdown' || event.type === 'click' || event.type === 'keydown')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    message(MUTATION_SAVE_MESSAGE)
  }
  const events = [
    'pointerdown',
    'click',
    'keydown',
    'beforeinput',
    'input',
    'change',
    'paste',
    'drop',
    'submit',
  ]
  for (const name of events) target.addEventListener(name, block, true)
  return () => {
    for (const name of events) target.removeEventListener(name, block, true)
  }
}
