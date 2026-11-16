import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Single-process stand-in for the PostgreSQL revision transaction.
 * One queue publishes the whole ledger, so a failed callback cannot leave a
 * revision, idempotency row, or outbox event behind. This is not a second
 * database and it is not safe for two processes sharing one file.
 */
export function emptyRevisionState() {
  return { files: {}, revisions: {}, leases: {}, idempotency: {}, uploads: {}, outbox: [] }
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Revision journal is unreadable')
  for (const key of ['files', 'revisions', 'leases', 'idempotency', 'uploads']) {
    if (value[key] !== undefined && (typeof value[key] !== 'object' || Array.isArray(value[key]))) {
      throw new Error('Revision journal is unreadable')
    }
  }
  if (value.outbox !== undefined && !Array.isArray(value.outbox)) throw new Error('Revision journal is unreadable')
  return {
    files: value.files || {},
    revisions: value.revisions || {},
    leases: value.leases || {},
    idempotency: value.idempotency || {},
    uploads: value.uploads || {},
    outbox: value.outbox || [],
  }
}

export function createMemoryJournal({ persist } = {}) {
  let state = emptyRevisionState()
  let tail = Promise.resolve()
  return {
    async load(next) {
      state = normalize(next)
    },
    read() {
      return structuredClone(state)
    },
    transaction(fileId, fn) {
      if (typeof fileId !== 'string' || fileId.length === 0) throw new TypeError('fileId required')
      const run = tail.then(async () => {
        const snapshot = structuredClone(state)
        const result = await fn(snapshot)
        if (persist) await persist(snapshot)
        state = snapshot
        return result
      })
      tail = run.then(() => {}, () => {})
      return run
    },
  }
}

export async function createFileJournal({ file }) {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('Revision journal file required')
  const journal = createMemoryJournal({
    persist: async (snapshot) => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 })
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
  })
  try {
    await journal.load(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return journal
}
