import type { PdfApi, SavedSignature, SignatureData } from '../../../pdf/src/shared/ipc'
import {
  MAX_SAVED_SIGNATURES,
  isSignatureData,
  prependSignature,
  removeSignature,
  sanitizeSignatures,
} from '../../../pdf/src/shared/signature-records'

const storeName = 'signatures'
const maxImageCharacters = 14 * 1024 * 1024
const maxGalleryBytes = 32 * 1024 * 1024
const maxCoordinates = 64_000

type GalleryApi = Pick<PdfApi, 'listSavedSignatures' | 'addSavedSignature' | 'removeSavedSignature'>
type AccountScope = [deploymentId: string, userId: string]

function boundedData(value: unknown): SignatureData | undefined {
  if (typeof value !== 'object' || value === null) return
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'image') {
    if (typeof candidate.image !== 'string' || candidate.image.length > maxImageCharacters ||
      !candidate.image.startsWith('iVBORw0KGgo') || !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.image)) return
  } else if (candidate.kind === 'strokes') {
    if (!Array.isArray(candidate.paths) || candidate.paths.length > maxCoordinates / 4) return
    let coordinates = 0
    for (const path of candidate.paths) {
      if (!Array.isArray(path)) return
      coordinates += path.length
      if (coordinates > maxCoordinates) return
    }
  }
  if (!isSignatureData(value)) return
  const {kind, width, height} = value
  if (width > 16_384 || height > 16_384 || width * height > 4_194_304) return
  return kind === 'image'
    ? {kind, width, height, image: value.image}
    : {kind, width, height, paths: value.paths}
}

function fitGallery(entries: SavedSignature[]): SavedSignature[] {
  let bytes = 0
  return entries.slice(0, MAX_SAVED_SIGNATURES).filter(entry => {
    const {data} = entry
    bytes += 256 + (data.kind === 'image'
      ? data.image.length * 2
      : data.paths.reduce((size, path) => size + path.length * 16 + 16, 0))
    return bytes <= maxGalleryBytes
  })
}

function readGallery(value: unknown): SavedSignature[] {
  const entries = Array.isArray(value) ? value.slice(0, MAX_SAVED_SIGNATURES) : []
  const valid = entries.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null ||
      typeof entry.id !== 'string' || entry.id.length > 80) return []
    const data = boundedData(entry.data)
    return data ? [{id: entry.id, createdAt: entry.createdAt, data}] : []
  })
  return fitGallery(sanitizeSignatures(valid))
}

function openGallery(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dyoffice-pdf-signatures', 1)
    let blocked = false
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onblocked = () => {
      blocked = true
      reject(new Error('The saved signature database is blocked'))
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      if (blocked) db.close()
      else resolve(db)
    }
  })
}

/** The account scope is checked against the same authenticated file grant on every use. */
export function createBrowserPdfSavedSignatures(
  authorize: (signal: AbortSignal) => Promise<AccountScope>,
  signal: AbortSignal,
): GalleryApi {
  async function access(update?: (entries: SavedSignature[]) => SavedSignature[]) {
    signal.throwIfAborted()
    const db = await openGallery()
    try {
      const scope = await authorize(signal)
      signal.throwIfAborted()
      const entries = await new Promise<SavedSignature[]>((resolve, reject) => {
        const transaction = db.transaction(storeName, update ? 'readwrite' : 'readonly')
        const store = transaction.objectStore(storeName)
        const read = store.get(scope)
        let entries: SavedSignature[] = []
        let failure: unknown
        const abort = () => {
          try { transaction.abort() } catch { /* Transaction already finished. */ }
        }
        signal.addEventListener('abort', abort, {once: true})
        transaction.onabort = () => {
          signal.removeEventListener('abort', abort)
          reject(failure ?? transaction.error ?? signal.reason ?? new Error('Saved signature access was interrupted'))
        }
        transaction.oncomplete = () => {
          signal.removeEventListener('abort', abort)
          resolve(entries)
        }
        read.onsuccess = () => {
          try {
            signal.throwIfAborted()
            entries = readGallery(read.result)
            if (!update) return
            entries = update(entries)
            if (entries.length > 0) store.put(entries, scope)
            else store.delete(scope)
          } catch (error) {
            failure = error
            abort()
          }
        }
      })
      const [deploymentId, userId] = await authorize(signal)
      if (deploymentId !== scope[0] || userId !== scope[1]) throw Error('The signed-in account changed')
      signal.throwIfAborted()
      return entries
    } finally {
      db.close()
    }
  }
  return {
    listSavedSignatures: () => access(),
    async addSavedSignature(candidate) {
      const data = boundedData(candidate)
      if (!data) throw Error('This signature is too large or invalid for reuse')
      return access(entries => fitGallery(prependSignature(entries, {
        id: crypto.randomUUID(), createdAt: Date.now(), data,
      })))
    },
    removeSavedSignature: id => access(entries => removeSignature(entries, id)),
  }
}
