/** The layout process supplies the exact font faces used to measure text. */
const registered = new Map<string, FontFace>()
const pending = new Map<string, Promise<FontFace | null>>()
let embeddedFamilies = new Set<string>()
let syncAttempt = 0

export function hasEmbeddedFontFamily(family: string): boolean {
  return embeddedFamilies.has(family.normalize('NFKC').toLowerCase())
}

declare global {
  interface Window {
    /** Set after each private-font sync completes; the fidelity harness waits on it before screenshots. */
    __genofficeDocFontsSynced?: boolean
  }
}

type PrivateFace = Awaited<ReturnType<Window['slidesApi']['privateFontFaces']>>[number]

function loadFace(face: PrivateFace): Promise<FontFace | null> {
  const existing = pending.get(face.id)
  if (existing) return existing
  const promise = (async () => {
    try {
      const data = await window.slidesApi.privateFontData(face.id)
      if (!data) return null
      return await new FontFace(face.family, data, {
        weight: face.bold ? '700' : '400',
        style: face.italic ? 'italic' : 'normal',
      }).load()
    } catch {
      return null
    }
  })().finally(() => pending.delete(face.id))
  pending.set(face.id, promise)
  return promise
}

/** Reconcile the deck's font faces. Desktop keeps the process-wide registrations. */
export async function syncPrivateFonts(replace = false): Promise<void> {
  const attempt = ++syncAttempt
  window.__genofficeDocFontsSynced = false
  try {
    const faces = await window.slidesApi.privateFontFaces()
    if (attempt !== syncAttempt || !Array.isArray(faces)) return
    const added = await Promise.all(faces.filter(face => !registered.has(face.id)).map(async face =>
      [face.id, await loadFace(face)] as const))
    if (attempt !== syncAttempt) return
    let changed = false
    if (replace) {
      const retained = new Set(faces.map(face => face.id))
      for (const [id, face] of registered) {
        if (retained.has(id)) continue
        document.fonts.delete(face)
        registered.delete(id)
        changed = true
      }
    }
    for (const [id, face] of added) {
      if (!face || registered.has(id)) continue
      document.fonts.add(face)
      registered.set(id, face)
      changed = true
    }
    if (replace) {
      embeddedFamilies = new Set([...registered.values()].map(face => face.family.normalize('NFKC').toLowerCase()))
    }
    // ArrayBuffer-backed faces don't emit loadingdone on the document's FontFaceSet.
    if (changed) {
      document.fonts.dispatchEvent(new Event('loadingdone'))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
  } catch {
    // A failed font request leaves the existing CSS fallbacks in place.
  } finally {
    if (attempt === syncAttempt) window.__genofficeDocFontsSynced = true
  }
}
