import type { CustomShowInfo } from '../shared/ipc'
import type { CustomShow } from './slideshow-utils'

type SlidePart = { partPath?: string }
export type LegacyShows = { key: string; value: string; shows: CustomShowInfo[] }

export function customShowPaths(shows: CustomShow[], slides: readonly SlidePart[]): CustomShowInfo[] {
  return shows.map(({ id, name, slideIndices }) => ({
    id,
    name,
    slidePaths: slideIndices.flatMap((index) => {
      const path = slides[index]?.partPath
      return path ? [path] : []
    }),
  }))
}

export function customShowIndexes(shows: CustomShowInfo[], slides: readonly SlidePart[]): CustomShow[] {
  const byPath = new Map(slides.map((slide, index) => [slide.partPath, index]))
  return shows.map(({ id, name, slidePaths }) => ({
    id,
    name,
    slideIndices: slidePaths.flatMap((path) => {
      const index = byPath.get(path)
      return index === undefined ? [] : [index]
    }),
  }))
}

/** Older Web and desktop builds stored the slide positions in browser storage. */
export function readLegacyShows(
  scope: string | null,
  stored: CustomShowInfo[],
  openedSlides: readonly SlidePart[],
  activeSlides: readonly SlidePart[],
  migrated?: LegacyShows,
): LegacyShows | undefined {
  if (scope === null) return
  const key = `ai-slides-custom-shows:${scope}`
  try {
    const value = localStorage.getItem(key)
    if (!value || (migrated?.key === key && migrated.value === value)) return
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return
    const candidates = parsed.flatMap((show, index): CustomShow[] => {
      if (typeof show?.name !== 'string' || !Array.isArray(show.slideIndices)) return []
      return [{
        id: `legacy-${index}`,
        name: show.name,
        slideIndices: show.slideIndices.filter((n: unknown) =>
          typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < openedSlides.length),
      }]
    })
    if (!candidates.length) return
    const signature = ({ name, slidePaths }: CustomShowInfo) => JSON.stringify([name, slidePaths])
    const signatures = new Set(stored.map(signature))
    const activePaths = new Set(activeSlides.map(slide => slide.partPath))
    const shows = customShowPaths(candidates, openedSlides).map(show => ({
      ...show,
      slidePaths: show.slidePaths.filter(path => activePaths.has(path)),
    }))
    return { key, value, shows: shows.filter(show => !signatures.has(signature(show))) }
  } catch {
    return
  }
}
