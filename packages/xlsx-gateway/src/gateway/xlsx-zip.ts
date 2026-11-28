import JSZip from 'jszip'
import { assertZipInflatesWithinLimits, type ZipLimits } from '@genoffice/zip-gate'
import { normalizeOoxmlPartPrefix } from './xlsx-namespace.ts'

/** Shared with the CLI's pre-open check so both layers accept the same files. */
export const XLSX_ZIP_LIMITS = {
  maxParts: 10_000,
  maxPartBytes: 256 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
} as const

function canonicalEntryName(raw: string): string | null {
  if (raw.includes('\0')) return null
  const segments: string[] = []
  for (const segment of raw.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.pop() === undefined) return null
      continue
    }
    segments.push(segment)
  }
  const name = segments.join('/')
  return name && /[/\\]$/.test(raw) ? `${name}/` : name
}

export async function loadSafeZip(buffer: Uint8Array, limits: ZipLimits = XLSX_ZIP_LIMITS): Promise<JSZip> {
  // Metered gate first: a forged central directory must not reach JSZip.
  await assertZipInflatesWithinLimits(buffer, limits)
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
  const paths = Object.keys(zip.files)
  if (paths.length > limits.maxParts) throw new Error('Workbook contains too many ZIP entries.')
  // Snapshot first: removing a folder entry such as "/" drops its children too.
  const files = paths.map((path) => [path, zip.files[path]] as const)
  for (const [path, file] of files) {
    const canonical = canonicalEntryName(path)
    if (canonical === null) throw new Error('Workbook contains an unsafe ZIP path.')
    if (canonical === path) continue
    zip.remove(path)
    if (file && !file.dir && canonical && !zip.files[canonical]) {
      zip.file(canonical, await file.async('uint8array'), { createFolders: false, date: file.date })
    }
  }
  return zip
}

async function readTextEntry(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path)
  if (!entry) throw new Error(`Workbook is missing ${path}.`)
  return entry.async('text')
}

export async function createBufferEntrySource(buffer: Uint8Array, limits: ZipLimits = XLSX_ZIP_LIMITS) {
  const zip = await loadSafeZip(buffer, limits)
  return {
    paths: async () =>
      Object.entries(zip.files)
        .filter(([, file]) => !file.dir)
        .map(([path]) => path),
    has: async (path: string) => zip.file(path) !== null,
    readText: async (path: string) => normalizeOoxmlPartPrefix(await readTextEntry(zip, path)),
  }
}
