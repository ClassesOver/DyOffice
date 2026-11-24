import type { PackageArchive } from './zip'

const slideNumber = /^ppt\/slides\/slide(\d+)\.xml$/
const highestSlideNumber = new WeakMap<PackageArchive, number>()

/** Keep a deleted path unavailable for the lifetime of a live deck. */
export function retireSlidePath(archive: PackageArchive, path: string): void {
  const number = Number(slideNumber.exec(path)?.[1])
  if (Number.isSafeInteger(number) && number > (highestSlideNumber.get(archive) ?? 0)) {
    highestSlideNumber.set(archive, number)
  }
}

/** Reserve fresh slide part names, including across history branches. */
export function reserveSlideNumbers(archive: PackageArchive, count: number): number {
  for (const path of archive.entries.keys()) retireSlidePath(archive, path)
  const first = (highestSlideNumber.get(archive) ?? 0) + 1
  highestSlideNumber.set(archive, first + count - 1)
  return first
}

export function nextSlidePath(archive: PackageArchive): string {
  return `ppt/slides/slide${reserveSlideNumbers(archive, 1)}.xml`
}

/** ST_SlideId is 256..2147483647. */
const SLIDE_ID_MIN = 256
const SLIDE_ID_MAX = 2147483647

interface RemovedSlide {
  id: number
  index: number
}
const removedSlides = new WeakMap<PackageArchive, Map<string, RemovedSlide>>()

function numericSlideId(tag: string): number | undefined {
  const match = /\sid\s*=\s*(?:"(\d+)"|'(\d+)')/.exec(tag)
  const id = Number(match?.[1] ?? match?.[2])
  return Number.isSafeInteger(id) && id >= SLIDE_ID_MIN && id <= SLIDE_ID_MAX ? id : undefined
}

/** Reserve removed IDs for this live package so a new slide cannot adopt their section references. */
export function rememberRemovedSlide(archive: PackageArchive, path: string, index: number, tag: string): void {
  const id = numericSlideId(tag)
  if (id === undefined) return
  let entries = removedSlides.get(archive)
  if (!entries) {
    entries = new Map()
    removedSlides.set(archive, entries)
  }
  entries.set(path, { id, index })
}

export function removedSlide(archive: PackageArchive, path: string): RemovedSlide | undefined {
  return removedSlides.get(archive)?.get(path)
}

/** Next p:sldId/@id for a presentation part: max+1, or the lowest free id once a deck sits at the ceiling. */
export function nextSlideId(presXml: string, archive?: PackageArchive, restoreId?: number): number {
  const used = new Set<number>()
  for (const [tag] of presXml.matchAll(/<p:sldId\s[^>]*>/g)) {
    const id = numericSlideId(tag)
    if (id !== undefined) used.add(id)
  }
  if (restoreId !== undefined && !used.has(restoreId)) return restoreId
  if (archive) for (const { id } of removedSlides.get(archive)?.values() ?? []) used.add(id)
  // Loop-based max: spreading `used` into Math.max overflows the call stack
  // on decks with hundreds of thousands of slides.
  let max = SLIDE_ID_MIN - 1
  for (const n of used) if (n > max) max = n
  let id = max + 1
  if (id > SLIDE_ID_MAX) {
    id = SLIDE_ID_MIN
    while (used.has(id)) {
      id++
      if (id > SLIDE_ID_MAX) throw new Error('pptx: slide id space exhausted')
    }
  }
  return id
}
