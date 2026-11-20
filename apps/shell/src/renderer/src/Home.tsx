import {onRevealWorkspaceFolder} from './file-events'
import {createPortal} from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
} from 'react'
import logoLockup from './assets/dyoffice-logo.svg'
import { FileBadge } from './file-badge'
import { placeFolderMenu } from './folder-menu-position'
import type {
  AccountStatus,
  CloudProjectKind,
  CloudProjectsSnapshot,
  FolderEntry,
  FolderListing,
  FolderRoot,
  HomeApi,
  MoveConflictPolicy,
  RecentEntry,
  FileSearchHit,
  FileSearchPage,
  FileSearchRerank,
} from '../../shared/home-api'
import type { IntegrationsApi } from '../../shared/integrations-api'
import { markText } from '../../shared/text-marks'
import { trapTab, useDismissablePopover, useEscapeToClose } from '@genoffice/ui'
import { fileCountLabel, visiblePageCount } from './counts'
import { useI18n } from './locale'
import type { I18n, StringKey } from './locale'
import { ConfirmDialog } from './ConfirmDialog'
import { SettingsModal } from './SettingsModal'
import type { SettingsTarget } from './SettingsModal'
import { skillUpdateDue } from './IntegrationsPane'
import { onFilesChanged } from './file-events'

import type { ProjectApi } from '@genoffice/project-store'

declare global {
  interface Window {
    aiOffice: HomeApi
    aiOfficeIntegrations?: IntegrationsApi
    /** Optional: a build without the project bridge keeps the panel in memory. */
    projectApi?: ProjectApi
  }
}

/** page size of the home list; scrolling to the bottom auto-loads the next page */
const PAGE_SIZE = 50
const WEB_PAGE_SIZE = 20

/** greeting sublines on the home page: one is picked at random on entry */
const GREET_ASK_KEYS = [
  'greetAsk1',
  'greetAsk2',
  'greetAsk3',
  'greetAsk4',
  'greetAsk5',
  'greetAsk6',
] as const satisfies readonly StringKey[]

/* Formats the open-local card advertises. Too long for the card at any window
   width, so it ellipsizes and a hover ScreenTip carries the full list. Keep in
   sync with the main-process open-dialog filter (OPEN_DIALOG_EXTENSIONS). */
const OPEN_LOCAL_EXTENSIONS =
  '.docx / .doc / .dot / .odt / .ott / .hwpx / .hwp / .xlsx / .xlsm / .xls / .csv / .tsv / .ods / .ots / .pptx / .ppt / .odp / .otp / .pdf / .md / .html'

/** drag payload of home file/folder rows (JSON array of absolute paths) */
const DRAG_PATHS_MIME = 'application/x-genoffice-paths'
/** hovering a collapsed folder this long while dragging expands it */
const DRAG_EXPAND_DELAY_MS = 600
/** expanded folders survive a home reload; the selection is per session */
const TREE_STATE_KEY = 'home.folderTree'
/** user-dragged sidebar width; unset keeps the stylesheet's default (genoffice#2169) */
const SIDEBAR_WIDTH_KEY = 'home.sidebarWidth'
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 480

function readSidebarWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH ? n : null
  } catch {
    return null
  }
}

/**
 * Width of the viewport that `position: fixed` elements anchor to. The layout
 * engine owns this coordinate system, so documentElement's client rect is the
 * value to compute menu offsets from; window.innerWidth can disagree on scaled
 * Linux desktops, which pushed row menus past the window's left edge (genoffice#1946).
 */
function fixedViewportWidth(): number {
  return document.documentElement.clientWidth
}

function FolderIcon({ size = 16, open = false }: { size?: number; open?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.1c.44 0 .85.19 1.13.52L8.4 4.4H13A1.5 1.5 0 0 1 14.5 5.9v5.6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V4z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill={open ? 'currentColor' : 'none'}
        fillOpacity={open ? 0.12 : 0}
      />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.12s' }}
    >
      <path
        d="M4.5 2.5l4 3.5-4 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

function MoreDots() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="12.8" cy="8" r="1.35" fill="currentColor" />
    </svg>
  )
}

function formatModified(mtimeMs: number, i18n: I18n): string {
  const date = new Date(mtimeMs)
  const now = new Date()
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
  if (days <= 0) {
    return `${i18n.t('today')} · ${date.toLocaleTimeString(i18n.dateLocale, { hour: '2-digit', minute: '2-digit' })}`
  }
  if (days === 1) return i18n.t('yesterday')
  return date.toLocaleDateString(i18n.dateLocale, { month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean)
}

function parentDir(path: string): string {
  const parts = splitPath(path)
  return parts[parts.length - 2] ?? ''
}

function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return path
  // keep the separator on a filesystem root ("/" or "C:\") instead of an empty or bare-drive string
  const dir = path.slice(0, cut)
  return dir === '' || /^[A-Za-z]:$/.test(dir) ? path.slice(0, cut + 1) : dir
}

function isUnder(root: string, path: string): boolean {
  if (path === root) return true
  // a root that already ends with a separator ("/" or "C:\") must not get a second one
  if (/[\\/]$/.test(root)) return path.startsWith(root)
  return path.startsWith(root + '/') || path.startsWith(root + '\\')
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Web identities may be opaque: display names come from the loaded directory metadata. */
function loadedName(path: string, roots: readonly FolderRoot[], listings?: ReadonlyMap<string, FolderListing>): string {
  const root = roots.find((entry) => entry.path === path)
  if (root) return root.name
  for (const listing of listings?.values() ?? []) {
    const entry = listing.folders.find((item) => item.path === path) ?? listing.files.find((item) => item.path === path)
    if (entry) return entry.name
  }
  return fileName(path)
}

function loadedParent(path: string, listings?: ReadonlyMap<string, FolderListing>): string {
  for (const listing of listings?.values() ?? []) {
    if (listing.files.some((entry) => entry.path === path)) return listing.dir
  }
  return dirOf(path)
}

function operationError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function baseName(entry: RecentEntry): string {
  return entry.ext ? entry.name.slice(0, -(entry.ext.length + 1)) : entry.name
}

/** the root that holds `path`; the deepest one when roots nest */
function rootOf(path: string, roots: readonly FolderRoot[]): FolderRoot | null {
  let best: FolderRoot | null = null
  for (const root of roots) {
    if (isUnder(root.path, path) && (!best || root.path.length > best.path.length)) best = root
  }
  return best
}

/** "Clients / Contracts" for a file under a root; the parent folder name elsewhere */
function locationLabel(path: string, roots: readonly FolderRoot[], listings?: ReadonlyMap<string, FolderListing>): string {
  const dir = loadedParent(path, listings)
  const root = rootOf(dir, roots)
  if (root) {
    if (dir === root.path) return root.name
    return crumbsOf(root, dir, listings).slice(1).map((entry) => entry.name).join(' / ')
  }
  return parentDir(path)
}

/** the folders between root and `dir` (inclusive) */
function crumbsOf(root: FolderRoot, dir: string, listings?: ReadonlyMap<string, FolderListing>): Array<{ path: string; name: string }> {
  const crumbs = [{ path: root.path, name: root.name }]
  if (dir === root.path) return crumbs
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  let acc = root.path
  for (const part of splitPath(dir.slice(root.path.length))) {
    acc = `${acc}${sep}${part}`
    crumbs.push({ path: acc, name: loadedName(acc, [root], listings) })
  }
  return crumbs
}

const FILTERS: { key: string; label: StringKey }[] = [
  { key: 'all', label: 'filterAll' },
  { key: 'docx', label: 'filterDocs' },
  { key: 'xlsx', label: 'filterSheets' },
  { key: 'pptx', label: 'filterSlides' },
  { key: 'pdf', label: 'filterPdf' },
  { key: 'md', label: 'filterMd' },
  { key: 'html', label: 'filterHtml' },
]

/** sidebar filter keys that stand for a family of extensions (mirrors recent-files.ts) */
const FILTER_FAMILY: Record<string, readonly string[]> = {
  docx: ['docx', 'doc', 'dot', 'odt', 'ott', 'hwpx', 'hwp'],
  xlsx: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots'],
  pptx: ['pptx', 'ppt', 'odp', 'otp'],
  md: ['md', 'markdown', 'txt', 'json'],
  html: ['html', 'htm'],
}

function matchesFilter(entry: RecentEntry, filter: string): boolean {
  if (filter === 'all') return true
  return (FILTER_FAMILY[filter] ?? [filter]).includes(entry.ext)
}

/** wrap every matched fragment of a name or folder label in the shared search-hit mark */
function highlightText(text: string, needles: readonly string[]): ReactElement[] | string {
  const marks = markText(text, needles)
  if (!marks.some((m) => m.hit)) return text
  return marks.map((m, i) =>
    m.hit ? (
      <mark key={i} className="search-hit">
        {m.text}
      </mark>
    ) : (
      <span key={i}>{m.text}</span>
    ),
  )
}

/** Check glyph marking the selected sort option; invisible on the others so labels stay aligned */
function SortCheck({ visible }: { visible: boolean }): ReactElement {
  return (
    <svg
      className="cloud-sort-check"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={visible ? undefined : { visibility: 'hidden' }}
    >
      <path
        d="M3 8.5L6.5 12L13 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ── Folder tree state (shared by the sidebar and the move picker) ──

interface TreeState {
  expanded: string[]
  /** the root the layout was saved for; a layout for another root is not applied */
  root: string | null
}

function readTreeState(): TreeState {
  try {
    const raw = JSON.parse(localStorage.getItem(TREE_STATE_KEY) ?? 'null') as TreeState | null
    if (raw && Array.isArray(raw.expanded)) {
      return {
        expanded: raw.expanded.filter((p): p is string => typeof p === 'string'),
        root: typeof raw.root === 'string' ? raw.root : null,
      }
    }
  } catch {
    // corrupt or absent: start collapsed
  }
  return { expanded: [], root: null }
}

function writeTreeState(state: TreeState): void {
  try {
    localStorage.setItem(TREE_STATE_KEY, JSON.stringify(state))
  } catch {
    // quota / private mode: the tree just forgets its layout
  }
}

/**
 * Lazily loaded folder listings keyed by directory. Listing a folder that is
 * already cached is a no-op; `invalidate` drops entries so the next render
 * refetches them (the main process reports changed directories via watch).
 */
function useFolderListings(onError: (error: unknown) => void) {
  const [listings, setListings] = useState<ReadonlyMap<string, FolderListing>>(new Map())
  // dir → whether a reload was requested while its request was in flight (the
  // in-flight answer may predate the change, so it is fetched once more)
  const inflight = useRef(new Map<string, boolean>())

  const load = useCallback((dir: string, force = false) => {
    if (inflight.current.has(dir)) {
      if (force) inflight.current.set(dir, true)
      return
    }
    inflight.current.set(dir, false)
    void window.aiOffice
      .listFolder(dir)
      .then((listing) => {
        setListings((prev) => {
          const next = new Map(prev)
          next.set(dir, listing)
          return next
        })
      })
      .catch(onError)
      .finally(() => {
        const again = inflight.current.get(dir)
        inflight.current.delete(dir)
        if (again) load(dir, true)
      })
  }, [onError])

  const invalidate = useCallback(
    (dirs: readonly string[]) => {
      setListings((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const dir of dirs) {
          if (next.delete(dir)) changed = true
        }
        return changed ? next : prev
      })
      for (const dir of dirs) load(dir, true)
    },
    [load],
  )

  const reset = useCallback(() => setListings(new Map()), [])

  /** shown or currently loading: the folders a watch event should refresh */
  const tracked = useCallback(
    (dir: string) => listings.has(dir) || inflight.current.has(dir),
    [listings],
  )

  return { listings, load, invalidate, reset, tracked }
}

// ── Move-to-folder picker ────────────────────────────────

interface FolderPickerProps {
  roots: readonly FolderRoot[]
  /** folders the moved items already live in (greyed, not selectable) */
  currentDirs: ReadonlySet<string>
  /** folders being moved: they and their descendants cannot be targets */
  movingDirs: readonly string[]
  count: number
  onCancel: () => void
  onPick: (dir: string) => void
  operationFailure?: string
}

function FolderPicker({
  roots,
  currentDirs,
  movingDirs,
  count,
  onCancel,
  onPick,
  operationFailure,
}: FolderPickerProps) {
  const { t } = useI18n()
  const [error, setError] = useState('')
  const fallback = useRef(t('askArtifactFailed'))
  fallback.current = t('askArtifactFailed')
  const reportError = useCallback((cause: unknown) => setError(operationError(cause, fallback.current)), [])
  const { listings, load } = useFolderListings(reportError)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(roots.map((r) => r.path)),
  )
  const [picked, setPicked] = useState<string | null>(null)
  const [focusedPath, setFocusedPath] = useState(roots[0]?.path ?? '')
  const pickedGeneration = useRef(0)
  const [query, setQuery] = useState('')
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creatingBusy, setCreatingBusy] = useState(false)
  const createPending = useRef(false)
  const attemptedCreate = useRef('')
  const createGeneration = useRef(0)

  useEffect(() => {
    for (const dir of expanded) load(dir)
  }, [expanded, load])

  useEscapeToClose(true, onCancel)

  const disabledDir = (dir: string) =>
    currentDirs.has(dir) ||
    movingDirs.some((m) => isUnder(m, dir)) ||
    rootOf(dir, roots)?.usable === false

  function pickerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, path: string) {
    if (event.nativeEvent.isComposing) return
    const row = event.currentTarget
    const rows = [...row.closest('.picker-tree')!.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const index = rows.indexOf(row)
    let next: HTMLElement | undefined
    if (event.key === 'Enter' || event.key === ' ') {
      if (!disabledDir(path)) {pickedGeneration.current++; setPicked(path)}
    } else if (event.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, index + 1)]
    else if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows.at(-1)
    else if (!query.trim() && event.key === 'ArrowRight') {
      if (!expanded.has(path)) {
        if (!listings.has(path) || listings.get(path)!.folders.length) setExpanded(previous => new Set([...previous, path]))
      } else next = row.parentElement?.querySelector<HTMLElement>(':scope > ul > li > [role="treeitem"]') ?? undefined
    } else if (!query.trim() && event.key === 'ArrowLeft') {
      if (expanded.has(path)) setExpanded(previous => {const next = new Set(previous); next.delete(path); return next})
      else next = row.closest('[role="group"]')?.parentElement?.querySelector<HTMLElement>(':scope > [role="treeitem"]') ?? undefined
    } else return
    event.preventDefault(); event.stopPropagation(); next?.focus()
  }

  // Enter or blur commits, Escape cancels; the blur an unmount may fire reads
  // the edit from a ref mirrored during render, so a finished edit is a no-op
  const creatingRef = useRef<{ parent: string; name: string } | null>(null)
  creatingRef.current = creatingIn ? { parent: creatingIn, name: newName } : null
  const commitCreate = async (explicit = true) => {
    if (createPending.current) return
    const pending = creatingRef.current
    const parent = pending?.parent
    const name = pending?.name.trim()
    if (!parent || !name) {creatingRef.current = null; setCreatingIn(null); return}
    const generation = createGeneration.current
    const selectionGeneration = pickedGeneration.current
    const attempt = JSON.stringify([parent, name])
    if (!explicit && attemptedCreate.current === attempt) return
    attemptedCreate.current = attempt
    createPending.current = true; setCreatingBusy(true); setError('')
    try {
      const result = await window.aiOffice.createFolder(parent, name)
      if (!result.ok) throw new Error(result.error ?? t('renameFailed'))
      if (generation === createGeneration.current) {
        creatingRef.current = null; setCreatingIn(null); setNewName('')
        if (result.path && selectionGeneration === pickedGeneration.current) setPicked(result.path)
      }
      load(parent, true)
      setExpanded((prev) => new Set([...prev, parent]))
    } catch (cause) {reportError(cause)}
    finally {createPending.current = false; setCreatingBusy(false)}
  }

  // name search flattens the tree to every loaded folder whose name matches;
  // folders not yet expanded are loaded on the fly one level at a time
  const needle = query.trim().toLowerCase()
  const renderNode = (entry: { path: string; name: string; hasSubfolders?: boolean }, depth: number): ReactElement => {
    const listing = listings.get(entry.path)
    const isOpen = expanded.has(entry.path)
    const children = listing?.folders ?? []
    const disabled = disabledDir(entry.path)
    const isCurrent = currentDirs.has(entry.path)
    return (
      <li key={entry.path}>
        <div
          className={`picker-row${picked === entry.path ? ' active' : ''}${disabled ? ' disabled' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          role="treeitem"
          tabIndex={focusedPath === entry.path ? 0 : -1}
          onFocus={() => setFocusedPath(entry.path)}
          onKeyDown={event => pickerKeyDown(event, entry.path)}
          aria-disabled={disabled}
          aria-selected={picked === entry.path}
          aria-expanded={children.length > 0 || (!listing && entry.hasSubfolders) ? isOpen : undefined}
          onClick={() => {
            if (!disabled) {pickedGeneration.current++; setPicked(entry.path)}
          }}
          onDoubleClick={() => {
            if (!disabled) onPick(entry.path)
          }}
        >
          <button
            className="tree-chevron"
            tabIndex={-1}
            aria-hidden="true"
            style={{ visibility: listing && children.length === 0 ? 'hidden' : undefined }}
            onClick={(e) => {
              e.stopPropagation()
              setFocusedPath(entry.path)
              e.currentTarget.parentElement?.focus()
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(entry.path)) next.delete(entry.path)
                else next.add(entry.path)
                return next
              })
            }}
          >
            <Chevron open={isOpen} />
          </button>
          <FolderIcon open={isOpen} />
          <span className="picker-name">{entry.name}</span>
          {isCurrent && <span className="picker-current">{t('currentFolder')}</span>}
        </div>
        {isOpen && (
          <ul role="group">
            {children.map((child) => renderNode(child, depth + 1))}
            {creatingIn === entry.path && (
              <li>
                <div className="picker-row" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
                  <span className="tree-chevron" aria-hidden="true" />
                  <FolderIcon />
                  <input
                    className="folder-rename-input inline"
                    autoFocus
                    placeholder={t('untitledFolder')}
                    value={newName}
                    disabled={creatingBusy}
                    onChange={(e) => {createGeneration.current++; setNewName(e.target.value)}}
                    onBlur={() => void commitCreate(false)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.nativeEvent.isComposing) return
                      if (e.key === 'Enter') void commitCreate()
                      if (e.key === 'Escape') {
                        createGeneration.current++
                        creatingRef.current = null
                        setCreatingIn(null)
                        setNewName('')
                      }
                    }}
                  />
                </div>
              </li>
            )}
          </ul>
        )}
      </li>
    )
  }

  const renderSearch = (): ReactElement => {
    const hits: Array<{ path: string; name: string; rel: string }> = []
    for (const listing of listings.values()) {
      for (const f of listing.folders) {
        if (f.name.toLowerCase().includes(needle)) {
          hits.push({ path: f.path, name: f.name, rel: locationLabel(f.path + '/x', roots, listings) })
        }
        if (!listings.has(f.path)) load(f.path)
      }
    }
    hits.sort((a, b) => a.name.localeCompare(b.name))
    if (hits.length === 0) return <p className="picker-empty">{t('noMatchingFolders')}</p>
    return (
      <ul role="tree">
        {hits.map((h, index) => {
          const disabled = disabledDir(h.path)
          return (
            <li key={h.path}>
              <div
                className={`picker-row${picked === h.path ? ' active' : ''}${disabled ? ' disabled' : ''}`}
                role="treeitem"
                tabIndex={focusedPath === h.path || (!hits.some(hit => hit.path === focusedPath) && index === 0) ? 0 : -1}
                onFocus={() => setFocusedPath(h.path)}
                onKeyDown={event => pickerKeyDown(event, h.path)}
                aria-disabled={disabled}
                aria-selected={picked === h.path}
                onClick={() => {
                  if (!disabled) {pickedGeneration.current++; setPicked(h.path)}
                }}
                onDoubleClick={() => {
                  if (!disabled) onPick(h.path)
                }}
              >
                <span className="tree-chevron" aria-hidden="true" />
                <FolderIcon />
                <span className="picker-name">{h.name}</span>
                <span className="picker-rel">{h.rel}</span>
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal picker-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('moveToFolderTitle')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('*')].filter(control => control.tabIndex >= 0 && !control.matches(':disabled'))
          const first = controls[0], last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus()}
          else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus()}
        }}
      >
        <h3>{t('moveToFolderTitle')}</h3>
        {(error || operationFailure) && <p className="home-action-error" role="alert">{error || operationFailure}</p>}
        <input
          className="picker-search"
          autoFocus
          type="search"
          placeholder={t('searchFolders')}
          value={query}
          onChange={(e) => {setQuery(e.target.value); setFocusedPath(roots[0]?.path ?? '')}}
        />
        <div className="picker-tree">
          {needle ? (
            renderSearch()
          ) : (
            <ul role="tree">{roots.map((root) => renderNode(root, 0))}</ul>
          )}
        </div>
        <div className="modal-buttons picker-buttons">
          <button
            className="btn btn-secondary picker-new"
            disabled={creatingBusy}
            onClick={() => {
              const parent = picked ?? roots.find((r) => r.usable)?.path
              if (!parent) return
              createGeneration.current++
              attemptedCreate.current = ''
              setExpanded((prev) => new Set([...prev, parent]))
              setCreatingIn(parent)
              setNewName('')
            }}
          >
            {t('newFolder')}
          </button>
          <span className="picker-spacer" />
          <button className="btn btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!picked || disabledDir(picked)}
            onClick={() => {
              if (picked) onPick(picked)
            }}
          >
            {t('moveCount', { n: count })}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Same-name conflict prompt ───────────────────────────

interface ConflictPromptProps {
  names: string[]
  onChoose: (policy: MoveConflictPolicy) => void
}

function ConflictPrompt({ names, onChoose }: ConflictPromptProps) {
  const { t } = useI18n()
  useEscapeToClose(true, () => onChoose('skip'))
  return (
    <div className="modal-overlay" onClick={() => onChoose('skip')}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('conflictTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t('conflictTitle')}</h3>
        <p>
          {names.length === 1
            ? t('conflictBodyOne', { name: names[0] })
            : t('conflictBodyMany', { n: names.length })}
        </p>
        {names.length > 1 && (
          <ul className="modal-file-list">
            {names.slice(0, 6).map((n) => (
              <li key={n}>{n}</li>
            ))}
            {names.length > 6 && <li>{t('deleteMoreCount', { n: names.length })}</li>}
          </ul>
        )}
        <div className="modal-buttons">
          <button className="btn btn-secondary" autoFocus onClick={() => onChoose('skip')}>
            {t('cancel')}
          </button>
          <button className="btn btn-secondary" onClick={() => onChoose('keepBoth')}>
            {t('conflictKeepBoth')}
          </button>
          <button className="btn btn-danger" onClick={() => onChoose('replace')}>
            {t('conflictReplace')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Starred-group picker ─────────────────────────────────

interface GroupPickerProps {
  /** existing group names (a group exists while it has at least one file) */
  groups: readonly string[]
  count: number
  onCancel: () => void
  /** put the files into an existing group */
  onPick: (group: string) => void
  /** create a group named `name` and put the files into it */
  onCreate: (name: string) => void
  /** take the files out of their group (back to the unfiltered list) */
  onRemove: () => void
}

/** Modal moving starred files into a named group. Deliberately minimal: no
 *  group rename/delete — a group is just a label its entries carry, and it
 *  vanishes when its last member leaves (via this dialog's remove action,
 *  an unstar, or a deleted file). */
function GroupPicker({ groups, count, onCancel, onPick, onCreate, onRemove }: GroupPickerProps) {
  const { t } = useI18n()
  const [name, setName] = useState('')

  useEscapeToClose(true, onCancel)

  const create = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setName('')
    onCreate(trimmed)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('moveToGroupTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t('moveToGroupTitle')}</h3>
        <p>{t('selectedCount', { n: count })}</p>
        {groups.length > 0 && (
          <ul className="group-picker-list">
            {groups.map((group) => (
              <li key={group}>
                <button
                  className="group-picker-row"
                  onClick={() => {
                    setName('')
                    onPick(group)
                  }}
                >
                  <FolderIcon size={16} />
                  <span className="group-picker-name">{group}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="group-picker-new">
          <input
            className="folder-rename-input"
            placeholder={t('groupNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') create()
            }}
          />
          <button className="btn btn-secondary" disabled={!name.trim()} onClick={create}>
            {t('newGroup')}
          </button>
        </div>
        <div className="modal-buttons">
          <button className="btn btn-secondary" onClick={onRemove}>
            {t('removeFromGroup')}
          </button>
          <button className="btn btn-secondary" autoFocus onClick={onCancel}>
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Account entry (bottom-left) ──────────────────────────
// Currently the Genspark (gsk) login entry; to be upgraded to a signup/account system later.
// Clicking it opens the settings modal directly (SettingsModal.tsx), which hosts
// login/logout plus preferences (language, theme, save location, update channel).

const LOGIN_POLL_MS = 2500
/** fallback deadline when the CLI does not report expires_in (device codes live ~300s) */
const LOGIN_MAX_WAIT_MS = 300_000

function AccountEntry({
  onStatusChange,
  onFileSearchSettingsChange,
  openRequest,
}: {
  onStatusChange?: (status: AccountStatus | null) => void
  onFileSearchSettingsChange?: () => void
  /** a fresh object per request: the home list asks to open the modal on a given block */
  openRequest?: SettingsTarget | null
}) {
  const { t } = useI18n()
  const [status, setStatus] = useState<AccountStatus | null>(null)

  useEffect(() => {
    onStatusChange?.(status)
  }, [status, onStatusChange])
  const [waiting, setWaiting] = useState(false)
  // incremented on login retry, resetting the polling timer
  const [loginNonce, setLoginNonce] = useState(0)
  const [loginError, setLoginError] = useState<
    'timeout' | 'launch' | 'network' | 'expired' | 'failed' | null
  >(null)
  // auth URL reported by the login CLI — rescue entry when the browser did not open
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [urlCopied, setUrlCopied] = useState(false)
  const loginDeadline = useRef(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skillUpdate, setSkillUpdate] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  // bumped on logout so an in-flight status refresh (which can still
  // report logged-in) is discarded instead of resurrecting the UI
  const statusSeq = useRef(0)

  // query login state once on mount
  useEffect(() => {
    let alive = true
    void window.aiOffice.accountStatus?.().then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [])

  // the skill state is a few file reads; re-probe after the modal closes so an
  // update done inside it clears the dot
  useEffect(() => {
    if (settingsOpen) return
    let alive = true
    void window.aiOfficeIntegrations?.status().then((st) => {
      if (alive) setSkillUpdate(skillUpdateDue(st))
    })
    return () => {
      alive = false
    }
  }, [settingsOpen])

  // login progress pushed from main (gsk login CLI output)
  useEffect(() => {
    const off = window.aiOffice.onAccountLogin?.((ev) => {
      if (ev.phase === 'url') {
        if (ev.url) setAuthUrl(ev.url)
        if (ev.expiresInSec) loginDeadline.current = Date.now() + ev.expiresInSec * 1000
      } else if (ev.phase === 'success') {
        void window.aiOffice.accountStatus().then((s) => {
          if (s.loggedIn) {
            setStatus(s)
            setWaiting(false)
            setAuthUrl(null)
          }
        })
      } else if (ev.phase === 'error') {
        setWaiting(false)
        setAuthUrl(null)
        setLoginError(
          ev.error === 'network' ? 'network' : ev.error === 'expired' ? 'expired' : 'failed',
        )
      }
    })
    return off
  }, [])

  // config-file polling stays as the fallback success path (works even if progress events are lost)
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void window.aiOffice.accountStatus().then((s) => {
        if (s.loggedIn) {
          setStatus(s)
          setWaiting(false)
          setAuthUrl(null)
        } else if (Date.now() > loginDeadline.current) {
          setWaiting(false)
          setAuthUrl(null)
          setLoginError('timeout')
        }
      })
    }, LOGIN_POLL_MS)
    return () => clearInterval(timer)
  }, [waiting, loginNonce])

  const loggedIn = status?.loggedIn ?? false
  const email = status?.email ?? ''
  const initial = email ? email[0].toUpperCase() : loggedIn ? 'G' : '?'
  const errorText = loginError
    ? {
        timeout: t('loginTimeout'),
        launch: t('loginLaunchFailed'),
        network: t('loginNetworkError'),
        expired: t('loginExpired'),
        failed: t('loginFailed'),
      }[loginError]
    : null

  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const doLogout = () => {
    setLoggingOut(true)
    statusSeq.current++
    void window.aiOffice.accountLogout().then(() => {
      setLoggingOut(false)
      setStatus({ loggedIn: false })
    })
  }

  const startLogin = () => {
    // clicking again while waiting = relaunch the login (main kills the stale CLI, so the new device code is the live one)
    setLoginError(null)
    setWaiting(true)
    setAuthUrl(null)
    setUrlCopied(false)
    loginDeadline.current = Date.now() + LOGIN_MAX_WAIT_MS
    setLoginNonce((n) => n + 1)
    void window.aiOffice.accountLogin().then((launched) => {
      if (!launched) {
        setWaiting(false)
        setLoginError('launch')
      }
    })
  }

  const openLoginUrl = () => void window.aiOffice.openLoginUrl?.()

  const copyLoginUrl = () => {
    if (!authUrl) return
    void navigator.clipboard.writeText(authUrl).then(() => {
      setUrlCopied(true)
      window.setTimeout(() => setUrlCopied(false), 2000)
    })
  }

  const [target, setTarget] = useState<SettingsTarget | null>(null)
  const openSettings = useCallback((to: SettingsTarget | null) => {
    // refresh the login state / credit balance; drop the response
    // when a logout happened while it was in flight
    const seq = statusSeq.current
    void window.aiOffice.accountStatus?.().then((s) => {
      if (seq === statusSeq.current) setStatus(s)
    })
    setTarget(to)
    setSettingsOpen(true)
  }, [])
  const handleClick = () => openSettings(null)
  useEffect(() => {
    if (openRequest) openSettings(openRequest)
  }, [openRequest, openSettings])

  return (
    <div className="account-entry">
      {settingsOpen && (
        <SettingsModal
          status={status}
          loggingOut={loggingOut}
          loginWaiting={waiting}
          loginUrl={authUrl}
          urlCopied={urlCopied}
          onOpenLoginUrl={openLoginUrl}
          onCopyLoginUrl={copyLoginUrl}
          onClose={() => setSettingsOpen(false)}
          onFileSearchChange={onFileSearchSettingsChange}
          onLogin={() => {
            setSettingsOpen(false)
            startLogin()
          }}
          onLogout={() => setConfirmSignOut(true)}
          skillUpdateDue={skillUpdate}
          onSkillUpdateDue={setSkillUpdate}
          target={target}
        />
      )}
      {confirmSignOut && (
        <ConfirmDialog
          title={t('confirmSignOutTitle')}
          body={t('confirmSignOutBody')}
          confirmLabel={t('logout')}
          cancelLabel={t('cancel')}
          danger
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => {
            setConfirmSignOut(false)
            doLogout()
          }}
        />
      )}
      {!settingsOpen && waiting && authUrl && (
        <div className="login-hint" role="status">
          <button className="login-hint-open" onClick={openLoginUrl}>
            {t('loginOpenShort')}
          </button>
          <button
            className={`login-hint-copy${urlCopied ? ' copied' : ''}`}
            onClick={copyLoginUrl}
            // static tip: screentips are suppressed from pointerdown until the pointer
            // leaves the control, so a swapped-in "copied" tip would never show — the
            // check-mark icon is the visible feedback
            data-tip={t('loginCopyUrl')}
            aria-label={urlCopied ? t('loginCopied') : t('loginCopyUrl')}
          >
            {urlCopied ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="m3.5 8.5 3 3 6-7"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect
                  x="5.5"
                  y="5.5"
                  width="7"
                  height="7"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M3.5 10.5V5a1.5 1.5 0 0 1 1.5-1.5h5.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
      )}
      <button
        className="account-btn"
        onClick={handleClick}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        data-tip={
          loggedIn
            ? email || t('loggedInGenspark')
            : waiting
              ? t('waitingLogin')
              : (errorText ?? t('loginGenspark'))
        }
        aria-label={t('settings')}
      >
        <span
          className={`account-avatar${loggedIn ? ' logged-in' : ''}${waiting ? ' waiting' : ''}`}
        >
          {waiting ? (
            <svg
              className="account-spinner"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.8"
                fill="none"
                strokeDasharray="26"
                strokeDashoffset="18"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            initial
          )}
          {skillUpdate && (
            <span className="account-badge" role="img" aria-label={t('intgUpdateDue')} />
          )}
        </span>
        <span className="account-text">
          <span className="account-name">
            {loggedIn
              ? email
                ? email.split('@')[0]
                : t('loggedIn')
              : waiting
                ? t('waitingShort')
                : t('login')}
          </span>
          {!loggedIn && !waiting && errorText && (
            <span className="account-sub error">{errorText}</span>
          )}
        </span>
        <svg
          className="account-chevron"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5 6.2 8 3.4l3 2.8M5 9.8l3 2.8 3-2.8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}

// ── Cloud (Genspark web) projects view ──────────────────

/** kind filter segments; labels shared with the recents type filter */
const CLOUD_FILTERS = [
  { key: 'all', label: 'filterAll' },
  { key: 'docs', label: 'filterDocs' },
  { key: 'sheets', label: 'filterSheets' },
  { key: 'slides', label: 'filterSlides' },
] as const satisfies readonly { key: 'all' | CloudProjectKind; label: StringKey }[]

/** module kind → file icon extension */
const CLOUD_KIND_EXT: Record<string, string> = { docs: 'docx', sheets: 'xlsx', slides: 'pptx' }

/** rows revealed per "load more" step; purely client-side over the local snapshot */
const CLOUD_REVEAL_STEP = 100

function CloudProjectsView() {
  const i18n = useI18n()
  const { t } = i18n
  const [snapshot, setSnapshot] = useState<CloudProjectsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [loginWaiting, setLoginWaiting] = useState(false)
  const [kind, setKind] = useState<'all' | CloudProjectKind>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'recent' | 'oldest'>('recent')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [revealed, setRevealed] = useState(CLOUD_REVEAL_STEP)
  const sortRef = useRef<HTMLDivElement>(null)

  // the local store paints instantly; a background sync replaces it when done.
  // a failed sync keeps whatever is shown; with nothing shown the
  // !snapshot && !loading branch below renders the retry state
  const startSync = () => {
    setSyncing(true)
    void window.aiOffice.cloudProjectsSync?.().then((synced) => {
      setSyncing(false)
      setLoading(false)
      if (synced) setSnapshot(synced)
    })
  }
  const startSyncRef = useRef(startSync)
  startSyncRef.current = startSync

  useEffect(() => {
    let cancelled = false
    void window.aiOffice.cloudProjectsCached?.().then((stored) => {
      if (cancelled || !stored) return
      setSnapshot((prev) => prev ?? stored)
      setLoading(false)
    })
    startSyncRef.current()
    return () => {
      cancelled = true
    }
  }, [])

  // the sign-in button reuses the account login flow; sync once it lands
  useEffect(() => {
    const off = window.aiOffice.onAccountLogin?.((ev) => {
      if (ev.phase === 'success') {
        setLoginWaiting(false)
        startSyncRef.current()
      } else if (ev.phase === 'error') {
        setLoginWaiting(false)
      }
    })
    return off
  }, [])

  // unified dismissal: outside press, window blur, chrome press (tab strip / window drag)
  useDismissablePopover(sortMenuOpen, () => setSortMenuOpen(false), {
    inside: () => [sortRef.current],
  })

  const startLogin = () => {
    setLoginWaiting(true)
    void window.aiOffice.accountLogin?.().then((ok) => {
      if (!ok) setLoginWaiting(false)
    })
  }

  const changeKind = (k: 'all' | CloudProjectKind) => {
    if (k === kind) return
    setKind(k)
    setRevealed(CLOUD_REVEAL_STEP)
  }

  const openProject = (projectUrl: string) => {
    void window.aiOffice.openCloudProject?.(projectUrl)
  }

  // filter / search / sort are all local over the snapshot — no requests
  const q = query.trim().toLowerCase()
  let list = snapshot?.projects.filter((proj) => kind === 'all' || proj.kind === kind) ?? []
  if (q) list = list.filter((proj) => proj.title.toLowerCase().includes(q))
  if (sort === 'oldest') list = [...list].reverse()
  const visible = list.slice(0, revealed)

  const renderRows = () => {
    const items: ReactElement[] = []
    for (const proj of visible) {
      items.push(
        <li key={proj.projectId}>
          <button
            className="cloud-row"
            data-tip={t('cloudOpenInBrowser')}
            data-tip-anchor=".cloud-row-external"
            data-tip-place="right"
            onClick={() => openProject(proj.projectUrl)}
          >
            <FileBadge ext={CLOUD_KIND_EXT[proj.kind] ?? ''} size={24} />
            <span className="cloud-row-main">
              <span className="cloud-row-title">{proj.title || t('untitled')}</span>
              <svg
                className="cloud-row-external"
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M6.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13.5h7A1.5 1.5 0 0 0 12.5 12V9.5M9.5 2.5h4v4M13 3l-5.5 5.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="cloud-row-time">
              {proj.ctimeMs ? formatModified(proj.ctimeMs, i18n) : ''}
            </span>
          </button>
        </li>,
      )
    }
    return items
  }

  const renderBody = () => {
    if (snapshot && !snapshot.available) {
      return (
        <p className="empty proj-empty">
          <span className="empty-hint">{t('cloudLoginHint')}</span>
          <button className="btn btn-secondary" disabled={loginWaiting} onClick={startLogin}>
            {loginWaiting ? t('waitingShort') : t('loginGenspark')}
          </button>
        </p>
      )
    }
    if (!snapshot) {
      if (loading || syncing) {
        return (
          <div className="load-more" aria-hidden="true">
            <span className="load-more-spinner" />
          </div>
        )
      }
      return (
        <p className="empty proj-empty">
          <span className="empty-hint">{t('cloudError')}</span>
          <button className="btn btn-secondary" onClick={() => startSync()}>
            {t('cloudRetry')}
          </button>
        </p>
      )
    }
    if (list.length === 0) {
      return (
        <p className="empty proj-empty">
          <span className="empty-hint">
            {t(q ? 'cloudNoResults' : kind === 'all' ? 'cloudEmpty' : 'emptyFiltered')}
          </span>
        </p>
      )
    }
    return (
      <div className="cloud-scroll">
        <div className="cloud-table">
          <div className="cloud-columns">
            <span className="col-name">{t('colName')}</span>
            <div className="cloud-col-sort" ref={sortRef}>
              <button
                className="cloud-col-sort-btn"
                aria-haspopup="menu"
                aria-expanded={sortMenuOpen}
                onClick={() => setSortMenuOpen((o) => !o)}
              >
                {t('colModified')}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  style={sort === 'oldest' ? { transform: 'rotate(180deg)' } : undefined}
                >
                  <path
                    d="M8 3v10M4.5 9.5L8 13l3.5-3.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {sortMenuOpen && (
                <div className="cloud-sort-menu" role="menu">
                  {(['recent', 'oldest'] as const).map((key) => (
                    <button
                      key={key}
                      className={sort === key ? 'active' : ''}
                      role="menuitemradio"
                      aria-checked={sort === key}
                      onClick={() => {
                        setSort(key)
                        setSortMenuOpen(false)
                        setRevealed(CLOUD_REVEAL_STEP)
                      }}
                    >
                      <SortCheck visible={sort === key} />
                      {t(key === 'recent' ? 'cloudSortRecent' : 'cloudSortOldest')}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <ul className="cloud-list">{renderRows()}</ul>
        </div>
        {list.length > revealed && (
          <div className="load-more">
            <button
              className="btn btn-secondary"
              onClick={() => setRevealed((n) => n + CLOUD_REVEAL_STEP)}
            >
              {t('cloudLoadMore')}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <main className="content">
      <section className="cloud-projects" aria-label={t('navCloud')}>
        <header className="cloud-hero">
          <div className="cloud-hero-top">
            <h1 className="cloud-title">{t('navCloud')}</h1>
          </div>
          <p className="cloud-subtitle">{t('cloudSubtitle')}</p>
          {snapshot?.available && (
            <div className="cloud-controls">
              <div className="cloud-seg" role="tablist" aria-label={t('filterAria')}>
                {CLOUD_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    className={kind === f.key ? 'active' : ''}
                    role="tab"
                    aria-selected={kind === f.key}
                    onClick={() => changeKind(f.key)}
                  >
                    {t(f.label)}
                  </button>
                ))}
              </div>
              <button
                className={`cloud-refresh-btn${syncing ? ' syncing' : ''}`}
                data-tip={t('cloudRefresh')}
                aria-label={t('cloudRefresh')}
                disabled={syncing}
                onClick={() => startSync()}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M13.6 8a5.6 5.6 0 1 1-1.64-3.96M13.6 2.4v3.2h-3.2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <div className="cloud-search">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
                  <path
                    d="M10.5 10.5L14 14"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
                <input
                  value={query}
                  placeholder={t('cloudSearchPlaceholder', { n: snapshot.projects.length })}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setRevealed(CLOUD_REVEAL_STEP)
                  }}
                />
              </div>
            </div>
          )}
        </header>
        {renderBody()}
      </section>
    </main>
  )
}

// ── Drop-to-open overlay ────────────────────────────────

/**
 * Full-window affordance while OS files hover over Home. Purely visual — the
 * actual open is owned by the preload drop bridge (installDropOpenBridge), so
 * this overlay stays pointer-events:none and never handles events itself.
 * Visibility tracks a dragenter/dragleave depth counter: `dragover` stops
 * being delivered while the cursor is stationary (macOS), so a debounce would
 * hide the overlay mid-drag. Enter fires before the matching leave when
 * moving between elements, so the depth never dips to zero inside the window.
 */
function DropToOpenOverlay(): ReactElement | null {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = (ev: DragEvent): boolean => ev.dataTransfer?.types.includes('Files') ?? false
    // NB: the preload drop bridge also listens here and cancels file drags, so
    // defaultPrevented can't discriminate anything at this layer — only zones
    // that stopPropagation (none on Home) would keep us out entirely.
    const onDragEnter = (ev: DragEvent) => {
      if (!hasFiles(ev)) return
      depth += 1
      setVisible(true)
    }
    const onDragLeave = (ev: DragEvent) => {
      if (!hasFiles(ev)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setVisible(false)
    }
    // drop/blur reset the depth outright: leaving the window mid-drag can eat
    // a dragleave, and a stuck overlay would be worse than a re-shown one
    const onHide = () => {
      depth = 0
      setVisible(false)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onHide)
    window.addEventListener('blur', onHide)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onHide)
      window.removeEventListener('blur', onHide)
    }
  }, [])
  const { t } = useI18n()
  if (!visible) return null
  return (
    <div className="home-drop-overlay" aria-hidden="true">
      <div className="home-drop-card">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3.5v11M7.5 10.5l4.5 4.5 4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        <h2>{t('dropToOpenTitle')}</h2>
        <p>{OPEN_LOCAL_EXTENSIONS}</p>
      </div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────

export interface HomeProps {
  renderHero?: (fallback:{greeting:string;guidance:string;language:string})=>ReactNode
  /** Web hosts retain the native layout while exposing only supported formats. */
  supportedFormats?: readonly string[]
  supportedNewFormats?: readonly string[]
  accountEntry?: ReactNode
  /** Omitted flags preserve desktop actions; Web hosts disable unavailable capabilities. */
  capabilities?: {localFolders?: boolean; copyPath?: boolean; duplicateFile?: boolean; starredGroups?: boolean; cloudProjects?: boolean; semanticRanking?: boolean; serverFileSort?: boolean}
  /** A host with empty-only directory deletion supplies its own accurate description. */
  folderDeleteDescription?: (name: string) => string
}

export function Home({supportedFormats, supportedNewFormats, accountEntry, folderDeleteDescription, capabilities, renderHero}:HomeProps = {}) {
  const i18n = useI18n()
  const { t, lang } = i18n
  const [actionError, setActionError] = useState('')
  const errorFallback = useRef(t('askArtifactFailed'))
  errorFallback.current = t('askArtifactFailed')
  const reportError = useCallback((cause: unknown) => setActionError(operationError(cause, errorFallback.current)), [])
  // 仅 Web 位置导航携带取消信号；桌面调用仍只传路径，避免把信号传入 IPC。
  const pendingReveal = useRef<AbortController | null>(null)
  const cancelReveal = useCallback(() => {pendingReveal.current?.abort(); pendingReveal.current = null}, [])
  useEffect(() => cancelReveal, [cancelReveal])
  const webReveal = supportedFormats !== undefined
  useEffect(() => {
    if (!webReveal) return
    return window.aiOfficeTabs?.onChanged(tabs => {
      if (tabs.some(tab => tab.active && tab.id !== 'home')) cancelReveal()
    })
  }, [webReveal, cancelReveal])
  const revealPath = async (path: string) => {
    if (!supportedFormats) {void window.aiOffice.revealPath(path).catch(reportError); return}
    cancelReveal()
    const controller = new AbortController()
    pendingReveal.current = controller
    setActionError('')
    try {await window.aiOffice.revealPath(path, controller.signal)}
    catch (cause) {if (!controller.signal.aborted) reportError(cause)}
    finally {if (pendingReveal.current === controller) pendingReveal.current = null}
  }
  const openPath = (path: string) => {
    cancelReveal()
    void window.aiOffice.openPath(path).catch(reportError)
  }
  const activeActions = useRef(new Set<string>())
  const attemptedDrafts = useRef(new Map<string, string>())
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(new Set())
  const runAction = async <T,>(key: string, work: () => Promise<T>, success: (result: T) => void) => {
    if (activeActions.current.has(key)) return
    activeActions.current.add(key); setPendingActions(new Set(activeActions.current)); setActionError('')
    try {success(await work())} catch (cause) {reportError(cause)}
    finally {activeActions.current.delete(key); setPendingActions(new Set(activeActions.current))}
  }
  // ── Paged list state (rows loaded for the current view + filter) ──
  const [entries, setEntries] = useState<RecentEntry[]>([])
  /** total count under the current view + filter (not just the loaded rows) */
  const [listTotal, setListTotal] = useState(0)
  const [webPage, setWebPage] = useState(0)
  const webPageRef = useRef(0)
  const [folderPage, setFolderPage] = useState(0)
  const folderRevealFile = useRef<string | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  /** sidebar Recent / Starred counts under the active type filter */
  const [navCounts, setNavCounts] = useState({ recent: 0, starred: 0 })
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const sidebarRef = useRef<HTMLElement>(null)
  const [view, setView] = useState<'recent' | 'starred'>('recent')
  // Genspark web projects take over the content area (like a selected folder)
  const [cloudMode, setCloudMode] = useState(false)
  const [filter, setFilter] = useState('all')
  // ── Starred groups (named buckets the Starred view can filter on) ──
  // groups that currently have at least one starred file (drives the pills)
  const [starredGroups, setStarredGroups] = useState<string[]>([])
  // the group pill filtering the Starred list; null shows every group
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  // starred rows being moved to a group (GroupPicker modal)
  const [groupPicker, setGroupPicker] = useState<string[] | null>(null)
  // ── File search (names + indexed content); active while the box has text ──
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPage, setSearchPage] = useState<FileSearchPage | null>(null)
  const [searchError, setSearchError] = useState('')
  const [rerank, setRerank] = useState<{ key: string; result: FileSearchRerank } | null>(null)
  // bumped when the Jev settings change so the current results are judged again (or the order dropped)
  const [rerankSettingsTick, setRerankSettingsTick] = useState(0)
  const [settingsRequest, setSettingsRequest] = useState<SettingsTarget | null>(null)
  useEffect(
    () =>
      window.aiOffice.onOpenSettings?.((target) =>
        setSettingsRequest({ section: target.section as SettingsTarget['section'] }),
      ),
    [],
  )
  const searchInputRef = useRef<HTMLInputElement>(null)
  // IME composition: wait for the committed text instead of searching each keystroke
  const composingRef = useRef(false)
  const searchSeq = useRef(0)
  const searchMoreRequest = useRef<number | null>(null)
  const [searchMoreBusy, setSearchMoreBusy] = useState(false)
  const [searchRefresh, setSearchRefresh] = useState(0)
  const searchActive = searchQuery.trim().length > 0
  // modified-column sort (WPS-style header popover), shared by the global and folder tables
  const [fileSort, setFileSort] = useState<'recent' | 'oldest' | undefined>(capabilities?.serverFileSort ? undefined : 'recent')
  const serverSort = capabilities?.serverFileSort && fileSort ? fileSort === 'oldest' ? 'modified-asc' : 'modified-desc' : undefined
  const [fileSortMenuOpen, setFileSortMenuOpen] = useState(false)
  const fileSortRef = useRef<HTMLDivElement>(null)
  const [rowMenu, setRowMenu] = useState<string | null>(null)
  // actions cell (… button + menu) of the row whose menu is open — the dismissal guard root
  const rowMenuWrapRef = useRef<HTMLSpanElement>(null)
  const rowMenuPopRef = useRef<HTMLDivElement>(null)
  const rowMenuAnchor = useRef<DOMRect | null>(null)
  const rowMenuTrigger = useRef<HTMLButtonElement | null>(null)
  const renderMenu = (menu: ReactElement) => supportedFormats ? createPortal(menu, document.body) : menu
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  const renameGeneration = useRef(0)
  const renamingRef = useRef(renaming)
  renamingRef.current = renaming
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)
  // unavailable recent entry (missing flag) the user clicked — offer list removal
  const [confirmMissing, setConfirmMissing] = useState<RecentEntry | null>(null)
  // name in the greeting; omitted when logged out
  const [accountName, setAccountName] = useState('')
  // Genspark Projects is web-account data, so its nav entry only shows when logged in
  const [loggedIn, setLoggedIn] = useState(false)
  // single source of account state: AccountEntry reports every change (initial
  // load, login, logout), keeping the greeting name and the nav entry in sync
  const handleAccountStatus = useCallback((s: AccountStatus | null) => {
    const on = s?.loggedIn ?? false
    setLoggedIn(on)
    if (!on) setCloudMode(false)
    const name = on ? (s?.email ?? '').split('@')[0] : ''
    setAccountName(name ? name[0].toUpperCase() + name.slice(1) : '')
  }, [])
  const [greetAskKey] = useState(
    () => GREET_ASK_KEYS[Math.floor(Math.random() * GREET_ASK_KEYS.length)]!,
  )

  // ── Folder tree state ──
  // the default save folder first, then the folders the user added; `root` is the default one
  const [roots, setRoots] = useState<FolderRoot[]>([])
  const root = roots[0] ?? null
  const canMove = roots.some((r) => r.usable)
  const editableAt = (path: string) => rootOf(path, roots)?.usable !== false
  const [panelDrop, setPanelDrop] = useState(false)
  const [treeState] = useState(readTreeState)
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(treeState.expanded))
  // a root without a saved layout of its own is opened once when first seen
  const seededRoot = useRef<string | null>(null)
  const {
    listings,
    load: loadFolder,
    invalidate: invalidateFolders,
    reset: resetFolders,
    tracked: trackedFolder,
  } = useFolderListings(reportError)
  const displayName = (path: string) => entries.find((entry) => entry.path === path)?.name ?? searchPage?.hits.find((entry) => entry.path === path)?.name ?? loadedName(path, roots, listings)
  // open folder menu: path + fixed-position anchor (viewport coords), so the
  // popup can escape the scrollable tree without the tree losing overflow-y
  const [folderMenu, setFolderMenu] = useState<{
    path: string
    where: 'tree' | 'table'
    x: number
    y: number
    above: number
    align: 'start' | 'end'
  } | null>(null)
  const menuOpenAt = (where: 'tree' | 'table', path: string) =>
    folderMenu?.where === where && folderMenu.path === path
  const folderMenuWrapRef = useRef<HTMLDivElement>(null)
  const folderMenuPopRef = useRef<HTMLDivElement>(null)
  const folderMenuTrigger = useRef<HTMLElement | null>(null)
  const folderMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      folderMenuTrigger.current?.focus({preventScroll: true})
      setFolderMenu(null)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus({preventScroll: true})
    }
  }
  const [folderRenaming, setFolderRenaming] = useState<{
    path: string
    where: 'tree' | 'table'
    value: string
  } | null>(null)
  const folderRenameGeneration = useRef(0)
  // inline "new folder" input in the tree, under this parent
  const [creating, setCreating] = useState<{ parent: string } | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const folderCreateGeneration = useRef(0)
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<{path: string} | null>(null)
  // move-to-folder picker for these paths; then the conflict prompt for the ones that collided
  const [movePicker, setMovePicker] = useState<string[] | null>(null)
  const movePickerRef = useRef(movePicker)
  movePickerRef.current = movePicker
  const [conflict, setConflict] = useState<{ paths: string[]; targetDir: string } | null>(null)
  const confirmationRef = useRef<HTMLDivElement>(null)
  const dialogOpener = useRef<HTMLElement | null>(null)
  const rememberDialogOpener = (element?: HTMLElement) => {
    if (element) dialogOpener.current = element
    else if (rowMenu) dialogOpener.current = rowMenuTrigger.current
    else if (folderMenu) dialogOpener.current = folderMenuTrigger.current
    else dialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  const fileDialogOpen = !!(confirmDelete || confirmMissing || confirmDeleteFolder || movePicker || conflict)
  useLayoutEffect(() => {
    if (!fileDialogOpen) return
    const opener = dialogOpener.current
    return () => {if (opener?.isConnected) opener.focus({preventScroll: true})}
  }, [fileDialogOpen])
  const confirmationOpen = !!(confirmDelete || confirmMissing || confirmDeleteFolder)
  useEffect(() => {
    if (!confirmationOpen) return
    const onKey = (event: KeyboardEvent) => {
      const dialog = confirmationRef.current
      if (event.key !== 'Tab' || !dialog) return
      if (!dialog.contains(document.activeElement)) {
        const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        event.preventDefault()
        ;(event.shiftKey ? controls.at(-1) : controls[0])?.focus()
      } else trapTab(dialog, event)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirmationOpen])
  // folder row currently hovered by a drag (sidebar or table)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragExpandTimer = useRef<number | null>(null)

  const loadRoot = useCallback(() => {
    void window.aiOffice.folderRoots().then((next) => {
      setRoots((prev) => {
        if (prev[0] && prev[0].path !== next[0]?.path) {
          // the default save folder changed in settings: the old tree is meaningless
          resetFolders()
          setSelectedFolder(null)
          setExpanded(new Set(next.map((r) => r.path)))
        } else if (prev.length > 0) {
          // a folder just added opens so its contents show right away
          const known = new Set(prev.map((r) => r.path))
          const added = next.filter((r) => !known.has(r.path)).map((r) => r.path)
          if (added.length > 0) setExpanded((e) => new Set([...e, ...added]))
        }
        return next
      })
    }).catch(reportError)
  }, [resetFolders, reportError])

  useEffect(loadRoot, [loadRoot])

  useEffect(() => {
    if (root?.usable) writeTreeState({ expanded: [...expanded], root: root.path })
  }, [expanded, root])

  useEffect(() => {
    if (!root?.usable) return
    if (seededRoot.current !== root.path) {
      seededRoot.current = root.path
      if (treeState.root !== root.path) {
        // a layout saved for another root is not ours: start from the root rows
        setExpanded(new Set(roots.map((r) => r.path)))
        return
      }
    }
    for (const dir of expanded) loadFolder(dir)
  }, [root, roots, expanded, loadFolder, treeState])

  useEffect(() => {
    if (selectedFolder) loadFolder(selectedFolder)
  }, [selectedFolder, loadFolder])

  // a remembered selection that no longer exists (deleted in Finder) falls back to the root
  useEffect(() => {
    if (!selectedFolder || roots.length === 0) return
    const owner = rootOf(selectedFolder, roots)
    if (!owner?.readable) {
      setSelectedFolder(null)
      return
    }
    if (listings.get(selectedFolder)?.missing) {
      setSelectedFolder(selectedFolder === owner.path ? null : dirOf(selectedFolder))
    }
  }, [roots, selectedFolder, listings])

  useEffect(() => {
    return window.aiOffice.onFolderChanged((dirs) => {
      invalidateFolders(dirs.filter(trackedFolder))
    })
  }, [invalidateFolders, trackedFolder])

  // ── Paged loading ──
  // stale responses are dropped via a request sequence number (when views/filters switch quickly)
  const requestSeq = useRef(0)
  const [readyPageSeq, setReadyPageSeq] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const moreRequest = useRef<number | null>(null)
  const firstPageRequest = useRef<number | null>(null)
  const entriesLen = useRef(0)
  entriesLen.current = entries.length

  /** reload the list; keepCount keeps the loaded row count (refresh), otherwise back to page one */
  const reload = (keepCount: boolean, requestedPage?: number) => {
    const seq = ++requestSeq.current
    moreRequest.current = null
    firstPageRequest.current = seq
    setListLoading(true)
    setListError('')
    if (!keepCount) {
      setEntries([])
      setListTotal(0)
    }
    const ext = filter === 'all' ? undefined : filter
    // the group pills only scope the Starred view's own list; the sidebar
    // counters and the other view stay group-agnostic
    const group = view === 'starred' && groupFilter ? groupFilter : undefined
    const paged = !!supportedFormats
    const pageIndex = paged ? requestedPage ?? (keepCount ? webPageRef.current : 0) : 0
    const limit = paged ? WEB_PAGE_SIZE : keepCount ? Math.max(entriesLen.current, PAGE_SIZE) : PAGE_SIZE
    const primary = view === 'recent' ? window.aiOffice.recents : window.aiOffice.starred
    const secondary = view === 'recent' ? window.aiOffice.starred : window.aiOffice.recents
    void primary({ offset: pageIndex * (paged ? WEB_PAGE_SIZE : 0), limit, ext, group, ...(serverSort ? {sort: serverSort} : {}) }).then((page) => {
      if (seq !== requestSeq.current) return
      if (paged && pageIndex > 0 && pageIndex * WEB_PAGE_SIZE >= page.total) {
        reloadRef.current(true, Math.max(0, Math.ceil(page.total / WEB_PAGE_SIZE) - 1))
        return
      }
      setEntries(page.entries)
      if (paged) {
        webPageRef.current = pageIndex
        setWebPage(pageIndex)
        tableRef.current?.scrollTo({top: 0})
      }
      setListLoading(false)
      setListTotal(page.total)
      setReadyPageSeq(seq)
      setNavCounts((prev) =>
        view === 'recent'
          ? { ...prev, recent: visiblePageCount(page) }
          : { ...prev, starred: visiblePageCount(page) },
      )
    }).catch((cause) => {
      if (seq !== requestSeq.current) return
      setListLoading(false)
      setListError(operationError(cause, errorFallback.current))
      if (keepCount && entriesLen.current > 0) reportError(cause)
    })
      .finally(() => {if(firstPageRequest.current === seq) firstPageRequest.current = null})
    // The other view fetches only its count under the same active filter.
    void secondary({ offset: 0, limit: 0, ext }).then((page) => {
      if (seq !== requestSeq.current) return
      setNavCounts((prev) =>
        view === 'recent'
          ? { ...prev, starred: visiblePageCount(page) }
          : { ...prev, recent: visiblePageCount(page) },
      )
    }).catch((cause) => {if (seq === requestSeq.current) reportError(cause)})
    // the group pills live on the renderer, so their list rides along with
    // every reload; a vanished group (last file unstarred/ungrouped) clears
    // the filter instead of showing a silently empty list
    if (capabilities?.starredGroups !== false) void window.aiOffice.starredGroups().then((groups) => {
      if (seq !== requestSeq.current) return
      setStarredGroups(groups)
      setGroupFilter((cur) => (cur && !groups.includes(cur) ? null : cur))
    }).catch((cause) => {if (seq === requestSeq.current) reportError(cause)})
  }
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  /** everything on screen re-pulls: the paged list, the root and every loaded folder */
  const refresh = () => {
    reloadRef.current(true)
    loadRoot()
    invalidateFolders([...listings.keys()])
  }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    reloadRef.current(false)
  }, [view, filter, groupFilter, serverSort])

  const q = searchQuery.trim()
  useEffect(() => {
    setSearchPage(null)
    setSearchError('')
    searchMoreRequest.current = null; setSearchMoreBusy(false)
    if (q) setSelected(new Set())
    if (!q) {
      searchSeq.current++
      setSearchPage(null)
      return
    }
    let timer = 0
    const run = () => {
      if (composingRef.current) {
        timer = window.setTimeout(run, 150)
        return
      }
      const seq = ++searchSeq.current
      const ext = filter === 'all' ? undefined : filter
      void window.aiOffice.searchFiles({ q, ext, limit: 100 }).then((page) => {
        if (seq !== searchSeq.current) return
        setSearchPage(page)
        setSearchError('')
        // results grow while the background index catches up
        if (page.index.pending > 0 || page.index.scanning) timer = window.setTimeout(run, 1500)
      }).catch((cause) => {if (seq === searchSeq.current) setSearchError(operationError(cause, errorFallback.current))})
    }
    timer = window.setTimeout(run, 150)
    return () => {
      window.clearTimeout(timer)
      searchMoreRequest.current = null
      searchSeq.current++
    }
  }, [q, filter, reportError, searchRefresh])

  async function loadMoreSearch() {
    if (!searchPage || searchPage.index.pending > 0 || searchPage.index.scanning || searchPage.hits.length >= searchPage.total) return
    const seq = searchSeq.current
    if (searchMoreRequest.current === seq) return
    searchMoreRequest.current = seq; setSearchMoreBusy(true)
    const offset = searchPage.hits.length
    try {
      const page = await window.aiOffice.searchFiles({q, ext: filter === 'all' ? undefined : filter, offset, limit: 100})
      if (seq !== searchSeq.current) return
      const known = new Set(searchPage.hits.map(hit => hit.path))
      // Inserts/deletions can shift offset pages. Re-read the first page when
      // totals or overlap expose that change instead of looping on duplicate hits.
      if (page.total !== searchPage.total || !page.hits.length || page.hits.some(hit => known.has(hit.path))) {
        setSearchRefresh(value => value + 1)
      } else setSearchPage(current => current ? {...page, hits: [...current.hits, ...page.hits]} : current)
    } catch (cause) { if (seq === searchSeq.current) reportError(cause) }
    finally { if (searchMoreRequest.current === seq) { searchMoreRequest.current = null; setSearchMoreBusy(false) } }
  }

  // Jev judges the top local hits once they settle; the main process answers null when reranking is off.
  // The key changes only with the query, filter or candidate set, so index polls do not restart the timer.
  const rerankKey =
    q && searchPage && searchPage.hits.length >= 2
      ? [q, filter, ...searchPage.hits.slice(0, 20).map((h) => h.path)].join('\n')
      : ''
  useEffect(() => {
    if (capabilities?.semanticRanking === false || !rerankKey) return
    const key = rerankKey
    const paths = key.split('\n').slice(2)
    const timer = window.setTimeout(() => {
      void window.aiOffice.rerankSearch({ q, paths }).then((result) => {
        if (result) setRerank({ key, result })
        else setRerank((cur) => (cur && cur.key === key ? null : cur))
      }).catch(reportError)
    }, 600)
    return () => window.clearTimeout(timer)
  }, [q, filter, rerankKey, rerankSettingsTick, reportError, capabilities?.semanticRanking])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key !== 'f' && event.key !== 'p') return
      const input = searchInputRef.current
      if (!input) return
      event.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const onFocus = () => refreshRef.current()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // a rename from the tab strip happens while this renderer already has focus
  useEffect(() => onFilesChanged(() => refreshRef.current()), [])

  const hasMore = !supportedFormats && entries.length < listTotal

  // unified dismissal: outside press, window blur, chrome press (tab strip / window drag)
  useDismissablePopover(fileSortMenuOpen, () => setFileSortMenuOpen(false), {
    inside: () => [fileSortRef.current],
  })

  const loadMore = () => {
    const seq = requestSeq.current
    if (readyPageSeq !== seq || moreRequest.current === seq || firstPageRequest.current === seq || !hasMore) return
    moreRequest.current = seq
    const ext = filter === 'all' ? undefined : filter
    const group = view === 'starred' && groupFilter ? groupFilter : undefined
    const api = view === 'recent' ? window.aiOffice.recents : window.aiOffice.starred
    const offset = entriesLen.current, known = new Set(entries.map(entry => entry.path))
    void api({ offset, limit: PAGE_SIZE, ext, group, ...(serverSort ? {sort: serverSort} : {}) }).then((page) => {
      if (seq !== requestSeq.current) return
      if(page.total !== listTotal || !page.entries.length || page.entries.some(entry => known.has(entry.path)) || new Set(page.entries.map(entry => entry.path)).size !== page.entries.length){reloadRef.current(false);return}
      setEntries((prev) => [...prev, ...page.entries])
      setListTotal(page.total)
    }).catch((cause) => {if (seq === requestSeq.current) reportError(cause)})
      .finally(() => {if(moreRequest.current === seq)moreRequest.current = null})
  }
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore

  // 本地反转需要先补齐列表；Web 采用服务端分页排序，不主动拉全。
  useEffect(() => {
    if (!capabilities?.serverFileSort && fileSort === 'oldest' && hasMore) loadMoreRef.current()
  }, [fileSort, hasMore, entries.length, readyPageSeq, capabilities?.serverFileSort])

  // Load the next page once the bottom sentinel enters the viewport (240px early);
  // depending on entries.length rebuilds the observer after each page — observe fires an immediate
  // callback, so while the sentinel stays in view we keep loading until full or exhausted
  const sentinelRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) loadMoreRef.current()
      },
      { rootMargin: '240px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, entries.length, readyPageSeq])

  // unified dismissal: outside press, window blur, chrome press (tab strip / window drag)
  useDismissablePopover(rowMenu !== null, () => setRowMenu(null), {
    inside: () => [rowMenuWrapRef.current, rowMenuPopRef.current],
  })
  useDismissablePopover(folderMenu !== null, () => setFolderMenu(null), {
    inside: () => [folderMenuWrapRef.current, folderMenuPopRef.current],
  })
  useLayoutEffect(() => {
    const el = rowMenuPopRef.current, anchor = rowMenuAnchor.current
    if (!supportedFormats || !rowMenu || !el || !anchor) return
    el.style.setProperty('position-anchor', 'none')
    el.style.setProperty('position-visibility', 'always')
    el.style.setProperty('position-try-fallbacks', 'none')
    const {left, top} = placeFolderMenu(
      {x: anchor.right, y: anchor.bottom + 4, above: anchor.top - 4, align: 'end'},
      {width: el.offsetWidth, height: el.offsetHeight},
      {width: fixedViewportWidth(), height: document.documentElement.clientHeight},
    )
    el.style.left = `${left}px`; el.style.top = `${top}px`
    el.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({preventScroll: true})
  }, [rowMenu, supportedFormats])
  useEffect(() => {
    if (!supportedFormats || !rowMenu) return
    // Revealing an offscreen trigger can queue a scroll event before the menu opens.
    // Only dismiss for a position change after opening, not that delayed event.
    const positions = new Map<Element, {top: number; left: number}>()
    for (let element: Element | null = rowMenuTrigger.current; element; element = element.parentElement) {
      positions.set(element, {top: element.scrollTop, left: element.scrollLeft})
    }
    const close = (event: Event) => {
      if (event.target instanceof Node && rowMenuPopRef.current?.contains(event.target)) return
      if (event.type === 'scroll' && event.target instanceof Element) {
        const previous = positions.get(event.target)
        if (previous && previous.top === event.target.scrollTop && previous.left === event.target.scrollLeft) return
      }
      setRowMenu(null)
    }
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close)
    return () => {window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close)}
  }, [rowMenu, supportedFormats])
  // the fixed-position folder menu would detach from its row while the tree scrolls
  useEffect(() => {
    if (!folderMenu) return
    const close = () => setFolderMenu(null)
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [folderMenu])
  // open to the right of the anchor, flipped above when short of room below, clamped to the viewport
  useLayoutEffect(() => {
    const el = folderMenuPopRef.current
    if (!folderMenu || !el) return
    const { left, top } = placeFolderMenu(
      folderMenu,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: fixedViewportWidth(), height: document.documentElement.clientHeight },
    )
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    if (supportedFormats) el.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({preventScroll: true})
  }, [folderMenu, supportedFormats])

  // Escape 关闭排序、行菜单和确认弹窗。
  useEscapeToClose(
    fileSortMenuOpen ||
      rowMenu !== null ||
      folderMenu !== null ||
      confirmDelete !== null ||
      confirmMissing !== null ||
      confirmDeleteFolder !== null,
    () => {
      if (fileSortMenuOpen) {
        setFileSortMenuOpen(false)
        fileSortRef.current?.querySelector<HTMLButtonElement>('.cloud-col-sort-btn')?.focus({preventScroll: true})
      }
      setRowMenu(null)
      setFolderMenu(null)
      setConfirmDelete(null)
      setConfirmMissing(null)
      setConfirmDeleteFolder(null)
    },
  )

  // WPS-style sortable "modified" column header, shared by both file tables
  const renderModifiedHeader = () => (
    <div className="cloud-col-sort" ref={fileSortRef}>
      <button
        className="cloud-col-sort-btn"
        title={t('colModified')}
        aria-haspopup="menu"
        aria-expanded={fileSortMenuOpen}
        onClick={() => setFileSortMenuOpen((o) => !o)}
      >
        {t('colModified')}
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          style={fileSort === 'oldest' ? { transform: 'rotate(180deg)' } : undefined}
        >
          <path
            d="M8 3v10M4.5 9.5L8 13l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {fileSortMenuOpen && (
        <div className="cloud-sort-menu" role="menu">
          {(['recent', 'oldest'] as const).map((key) => (
            <button
              key={key}
              className={fileSort === key ? 'active' : ''}
              role="menuitemradio"
              aria-checked={fileSort === key}
              onClick={() => {
                setFileSort(key)
                setFileSortMenuOpen(false)
              }}
            >
              <SortCheck visible={fileSort === key} />
              {t(key === 'recent' ? 'cloudSortRecent' : 'cloudSortOldest')}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  // ── Plain view (no folder selected): filtering runs in the main process; entries is the visible list ──
  const selectedPaths = entries.filter((e) => selected.has(e.path)).map((e) => e.path)
  const allSelected = entries.length > 0 && selectedPaths.length === entries.length

  // folder view: files of the selected folder under the type filter; shares the same `selected` set
  const folderListing = selectedFolder ? listings.get(selectedFolder) : undefined
  const folderFiles = (folderListing?.files ?? []).filter((e) => matchesFilter(e, filter))
  const folderSubfolders = folderListing?.folders ?? []
  const sortedFolderFiles = capabilities?.serverFileSort && fileSort
    ? [...folderFiles].sort((a, b) => (fileSort === 'oldest' ? a.mtimeMs - b.mtimeMs : b.mtimeMs - a.mtimeMs) || a.path.localeCompare(b.path))
    : fileSort === 'oldest' ? [...folderFiles].reverse() : folderFiles
  const folderTotal = folderSubfolders.length + folderFiles.length
  const currentFolderPage = Math.min(folderPage, Math.max(0, Math.ceil(folderTotal / WEB_PAGE_SIZE) - 1))
  const folderStart = supportedFormats ? currentFolderPage * WEB_PAGE_SIZE : 0
  const visibleSubfolders = supportedFormats ? folderSubfolders.slice(folderStart, folderStart + WEB_PAGE_SIZE) : folderSubfolders
  const visibleFolderFiles = supportedFormats ? sortedFolderFiles.slice(Math.max(0, folderStart - folderSubfolders.length), Math.max(0, folderStart + WEB_PAGE_SIZE - folderSubfolders.length)) : sortedFolderFiles
  const folderSelectedPaths = folderFiles.filter((e) => selected.has(e.path)).map((e) => e.path)
  const folderAllSelected =
    visibleFolderFiles.length > 0 && visibleFolderFiles.every(e => selected.has(e.path))

  useEffect(() => {setFolderPage(0)}, [selectedFolder, filter, fileSort])
  useEffect(() => {
    if (!supportedFormats || !folderRevealFile.current) return
    const index = sortedFolderFiles.findIndex(file => file.path === folderRevealFile.current)
    if (index < 0) return
    folderRevealFile.current = null
    setFolderPage(Math.floor((folderSubfolders.length + index) / WEB_PAGE_SIZE))
  }, [supportedFormats, sortedFolderFiles, folderSubfolders.length])

  function renderFilePager(page: number, total: number, change: (page: number) => void, loading = false) {
    if (!supportedFormats) return null
    const pages = Math.max(1, Math.ceil(total / WEB_PAGE_SIZE))
    const english = lang === 'en'
    return <nav className="home-file-pager" aria-label={english ? 'File pagination' : '文件分页'}>
      <span className="home-file-range">{english ? `${total ? page * WEB_PAGE_SIZE + 1 : 0}–${Math.min((page + 1) * WEB_PAGE_SIZE, total)} of ${total}` : `第 ${total ? page * WEB_PAGE_SIZE + 1 : 0}–${Math.min((page + 1) * WEB_PAGE_SIZE, total)} 项 · 共 ${total} 项`}</span>
      <div><button type="button" disabled={loading || page === 0} onClick={() => change(page - 1)}>{english ? 'Previous' : '上一页'}</button><span role="status" aria-live="polite">{loading ? english ? 'Loading…' : '正在加载…' : english ? `Page ${page + 1} of ${pages}` : `第 ${page + 1} / ${pages} 页`}</span><button type="button" disabled={loading || page + 1 >= pages} onClick={() => change(page + 1)}>{english ? 'Next' : '下一页'}</button></div>
    </nav>
  }

  function changeWebPage(next: number) {
    if (listLoading) return
    setSelected(new Set()); setRowMenu(null)
    reloadRef.current(true, next)
  }

  function changeFolderPage(next: number) {
    setSelected(new Set()); setRowMenu(null); setFolderMenu(null)
    setFolderPage(next)
    tableRef.current?.scrollTo({top: 0})
  }

  const changeView = (next: 'recent' | 'starred') => {
    folderRevealFile.current = null
    cancelReveal()
    setView(next)
    setSelectedFolder(null)
    setCloudMode(false)
    setSelected(new Set())
    setRowMenu(null)
    setGroupFilter(null)
  }

  const changeFilter = (key: string) => {
    folderRevealFile.current = null
    cancelReveal()
    setFilter(key)
    setSelected(new Set())
    setRowMenu(null)
  }

  const changeGroupFilter = (group: string | null) => {
    cancelReveal()
    setGroupFilter(group)
    setSelected(new Set())
    setRowMenu(null)
  }

  const selectFolder = (dir: string) => {
    folderRevealFile.current = null
    cancelReveal()
    setFolderPage(0)
    setSelectedFolder(dir)
    setCloudMode(false)
    setSelected(new Set())
    setRowMenu(null)
    setFolderMenu(null)
  }

  const toggleExpanded = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }

  const expandTo = (dir: string) => {
    const owner = rootOf(dir, roots)
    if (!owner) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const crumb of crumbsOf(owner, dir)) next.add(crumb.path)
      return next
    })
  }

  useEffect(() => onRevealWorkspaceFolder(({dir, fileId}) => {
    const owner = rootOf(dir, roots)
    if (!owner?.readable) return
    folderRevealFile.current = fileId ?? null
    setExpanded(previous => new Set([...previous, ...crumbsOf(owner, dir).map(crumb => crumb.path)]))
    setSelectedFolder(dir)
    setCloudMode(false)
    setSearchQuery('')
    setFilter('all')
    setSelected(new Set(fileId ? [fileId] : []))
    setRowMenu(null)
    setFolderMenu(null)
  }), [roots])

  const toggleSelect = (path: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.path)))
  }

  const toggleSelectAllFolder = () => {
    setSelected(folderAllSelected ? new Set() : new Set(visibleFolderFiles.map((e) => e.path)))
  }

  const toggleStar = (path: string) => {
    void runAction(`star:${path}`, () => window.aiOffice.toggleStar(path), refresh)
  }

  const removeRecent = (paths: string[]) => {
    setRowMenu(null)
    void runAction(`recent:${paths.join('\n')}`, () => window.aiOffice.removeRecent(paths), () => {setSelected((current) => current === selected ? new Set() : current); refresh()})
  }

  /** the Starred view's bulk action: drop the stars, keep the recents entries */
  const unstarSelected = (paths: string[]) => {
    setRowMenu(null)
    void runAction(`unstar:${paths.join('\n')}`, () => window.aiOffice.unstarPaths(paths), () => {setSelected((current) => current === selected ? new Set() : current); refresh()})
  }

  /** put rows into a group (null = out of their group); the pills list and
   *  the filtered list come back with the refresh */
  const assignGroup = (paths: string[], group: string | null) => {
    setRowMenu(null)
    void runAction(`group:${paths.join('\n')}`, () => window.aiOffice.setStarredGroup(paths, group), () => {setGroupPicker(null); refresh()})
  }

  const deleteFiles = (paths: string[]) => {
    rememberDialogOpener()
    setActionError('')
    setRowMenu(null)
    setConfirmDelete(paths)
  }

  const confirmDeleteNow = () => {
    const paths = confirmDelete ?? []
    if (!paths.length) return
    void runAction(`delete:${paths.join('\n')}`, () => window.aiOffice.deleteFiles(paths), () => {
      setConfirmDelete((current) => current === paths ? null : current)
      setSelected((current) => current === selected ? new Set() : current)
      refresh()
    })
  }

  const duplicateFile = (path: string) => {
    setRowMenu(null)
    void runAction(`duplicate:${path}`, () => window.aiOffice.duplicateFile(path), refresh)
  }

  const startRename = (entry: RecentEntry) => {
    renameGeneration.current++
    setRowMenu(null)
    setActionError('')
    attemptedDrafts.current.delete(`rename:${entry.path}`)
    setRenaming({ path: entry.path, value: baseName(entry) })
  }

  const commitRename = (entry: RecentEntry, explicit = true) => {
    const pending = renamingRef.current
    if (!pending || pending.path !== entry.path) return
    const value = pending.value.trim()
    if (!value || value === baseName(entry)) {renamingRef.current = null; setRenaming(null); return}
    const generation = renameGeneration.current
    const key = `rename:${entry.path}`
    if (!explicit && attemptedDrafts.current.get(key) === value) return
    attemptedDrafts.current.set(key, value)
    const newName = entry.ext ? `${value}.${entry.ext}` : value
    void runAction(`rename:${entry.path}`, async () => {
      const result = await window.aiOffice.renameFile(entry.path, newName)
      if (!result.ok) throw new Error(result.error ?? t('renameFailed'))
    }, () => {
      if (generation === renameGeneration.current) {renamingRef.current = null; setRenaming(null)}
      refresh()
    })
  }

  // ── Folder actions ──

  const startCreateFolder = (parent: string) => {
    folderCreateGeneration.current++
    setActionError('')
    attemptedDrafts.current.delete(`create:${parent}`)
    setFolderMenu(null)
    expandTo(parent)
    setCreating({ parent })
    setNewFolderName('')
  }

  // inline inputs commit on Enter or blur and cancel on Escape; the blur an
  // unmount may fire reads the edit from refs mirrored during render, so a
  // finished or cancelled edit is a no-op (see FolderPicker.commitCreate)
  const creatingFolderRef = useRef<{ parent: string; name: string } | null>(null)
  creatingFolderRef.current = creating ? { parent: creating.parent, name: newFolderName } : null
  const folderRenamingRef = useRef(folderRenaming)
  folderRenamingRef.current = folderRenaming

  const commitCreateFolder = async (explicit = true) => {
    const pending = creatingFolderRef.current
    const name = pending?.name.trim()
    if (!pending || !name) {creatingFolderRef.current = null; setCreating(null); return}
    const generation = folderCreateGeneration.current
    const key = `create:${pending.parent}`
    if (!explicit && attemptedDrafts.current.get(key) === name) return
    attemptedDrafts.current.set(key, name)
    await runAction(`create:${pending.parent}`, async () => {
      const result = await window.aiOffice.createFolder(pending.parent, name)
      if (!result.ok) throw new Error(result.error ?? t('renameFailed'))
    }, () => {
      if (generation === folderCreateGeneration.current) {creatingFolderRef.current = null; setCreating(null); setNewFolderName('')}
      invalidateFolders([pending.parent])
    })
  }

  const startRenameFolder = (entry: { path: string; name: string }, where: 'tree' | 'table') => {
    folderRenameGeneration.current++
    setActionError('')
    attemptedDrafts.current.delete(`rename:${entry.path}`)
    setFolderMenu(null)
    setRowMenu(null)
    setFolderRenaming({ path: entry.path, where, value: entry.name })
  }

  const commitRenameFolder = async (explicit = true) => {
    const pending = folderRenamingRef.current
    if (!pending) return
    const value = pending.value.trim()
    if (!value || value === displayName(pending.path)) {folderRenamingRef.current = null; setFolderRenaming(null); return}
    const generation = folderRenameGeneration.current
    const key = `rename:${pending.path}`
    if (!explicit && attemptedDrafts.current.get(key) === value) return
    attemptedDrafts.current.set(key, value)
    await runAction(`rename:${pending.path}`, async () => {
      const result = await window.aiOffice.renameFolder(pending.path, value)
      if (!result.ok) throw new Error(result.error ?? t('renameFailed'))
      return result
    }, (result) => {
      if (generation === folderRenameGeneration.current) {folderRenamingRef.current = null; setFolderRenaming(null)}
      if (result.path) {
        const renamed = result.path
        // Desktop paths rebase; a Web rename intentionally retains its stable identity.
        const rebase = (p: string) => p === pending.path || isUnder(pending.path, p) ? renamed + p.slice(pending.path.length) : p
        setExpanded((prev) => new Set([...prev].map(rebase)))
        setSelectedFolder((current) => current ? rebase(current) : current)
      }
      refresh()
    })
  }

  const confirmDeleteFolderNow = async () => {
    const confirmation = confirmDeleteFolder
    if (!confirmation) return
    const dir = confirmation.path
    await runAction(`delete-folder:${dir}`, () => window.aiOffice.deleteFolder(dir), () => {
      setConfirmDeleteFolder((current) => current === confirmation ? null : current)
      setSelectedFolder((current) => current && (current === dir || isUnder(dir, current)) ? dirOf(dir) : current)
      refresh()
    })
  }

  const startMove = (paths: string[]) => {
    rememberDialogOpener()
    setActionError('')
    setRowMenu(null)
    setFolderMenu(null)
    if (paths.length > 0) setMovePicker(paths)
  }

  const doMove = async (paths: string[], targetDir: string, policy: MoveConflictPolicy) => {
    await runAction(`move:${paths.join('\n')}`, () => window.aiOffice.movePaths(paths, targetDir, policy), (result) => {
      if (result.moved.length > 0) {
        setSelectedFolder((current) => {
          if (!current) return current
          const moved = result.moved.find(({from}) => current === from || isUnder(from, current))
          return moved ? moved.to + current.slice(moved.from.length) : current
        })
      }
      refresh()
      const ownsPicker = movePickerRef.current === movePicker
      const failedPaths = result.failed.map((entry) => entry.path)
      const nextPicker = failedPaths.length > 0 ? failedPaths : null
      const nextConflict = result.conflicts.length > 0 ? {paths: result.conflicts, targetDir} : null
      if (result.failed.length > 0) {
        setActionError(result.failed[0].error)
      }
      setMovePicker((current) => current === movePicker ? nextPicker : current)
      setSelected((current) => current === selected ? new Set(failedPaths) : current)
      if (ownsPicker) setConflict((current) => current === conflict ? nextConflict : current)
    })
  }

  // ── Drag & drop (rows → folder rows) ──

  const dragPathsFor = (path: string, context: 'global' | 'folder'): string[] => {
    const pool = context === 'folder' ? folderSelectedPaths : selectedPaths
    return pool.includes(path) ? pool : [path]
  }

  const onRowDragStart = (event: ReactDragEvent, paths: string[]) => {
    event.dataTransfer.setData(DRAG_PATHS_MIME, JSON.stringify(paths))
    event.dataTransfer.effectAllowed = 'move'
    setRowMenu(null)
  }

  const readDragPaths = (event: ReactDragEvent): string[] => {
    try {
      const raw = JSON.parse(event.dataTransfer.getData(DRAG_PATHS_MIME)) as unknown
      return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
    } catch {
      return []
    }
  }

  const clearDragExpand = () => {
    if (dragExpandTimer.current !== null) {
      window.clearTimeout(dragExpandTimer.current)
      dragExpandTimer.current = null
    }
  }

  const folderDropProps = (dir: string, { autoExpand }: { autoExpand: boolean }) => ({
    onDragOver: (event: ReactDragEvent) => {
      if (rootOf(dir, roots)?.usable === false) return
      if (!event.dataTransfer.types.includes(DRAG_PATHS_MIME)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (dropTarget !== dir) {
        setDropTarget(dir)
        clearDragExpand()
        if (autoExpand && !expanded.has(dir)) {
          dragExpandTimer.current = window.setTimeout(() => {
            setExpanded((prev) => new Set([...prev, dir]))
          }, DRAG_EXPAND_DELAY_MS)
        }
      }
    },
    onDragLeave: (event: ReactDragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      if (dropTarget === dir) setDropTarget(null)
      clearDragExpand()
    },
    onDrop: (event: ReactDragEvent) => {
      event.preventDefault()
      setDropTarget(null)
      clearDragExpand()
      const paths = readDragPaths(event).filter((p) => p !== dir && !isUnder(p, dir))
      if (paths.length > 0) void doMove(paths, dir, 'ask')
    },
  })

  // ── New file (lands in the selected folder) ──
  const newFileOpts =
    selectedFolder && root && selectedFolder !== root.path && rootOf(selectedFolder, roots)?.usable
      ? { dir: selectedFolder }
      : undefined

  const NEW_ITEMS = [
    {
      ext: 'docx',
      title: t('newDoc'),
      sub: '.docx',
      action: () => window.aiOffice.newDoc(newFileOpts),
    },
    {
      ext: 'xlsx',
      title: t('newSheet'),
      sub: '.xlsx',
      action: () => window.aiOffice.newSheet(newFileOpts),
    },
    {
      ext: 'pptx',
      title: t('newSlide'),
      sub: '.pptx',
      action: () => window.aiOffice.newSlide(newFileOpts),
    },
    {
      ext: 'md',
      title: t('newMarkdown'),
      sub: '.md',
      action: () => window.aiOffice.newMarkdown(newFileOpts),
    },
    {
      ext: 'html',
      title: t('newHtml'),
      sub: '.html',
      action: () => window.aiOffice.newHtml(newFileOpts),
    },
    {
      ext: 'pdf',
      title: t('newPdf'),
      sub: '.pdf',
      action: () => window.aiOffice.newPdf(newFileOpts),
    },
  ]

  function renderQuickCards() {
    return (
      <div className="quick-cards">
        {NEW_ITEMS.filter(item => !supportedFormats || supportedFormats.includes(item.ext)).map((item) => (
          <button key={item.ext} className="quick-card" disabled={Boolean(supportedNewFormats && !supportedNewFormats.includes(item.ext))} title={supportedNewFormats && !supportedNewFormats.includes(item.ext) ? '暂不支持新建此格式，可通过打开文件导入现有文档。' : undefined} onClick={() => void item.action().catch(reportError)}>
            <FileBadge ext={item.ext} size={30} />
            <span className="quick-text">
              <span className="quick-title-row">
                <span className="quick-title">{item.title}</span>
                <span className="ai-chip">AI</span>
              </span>
              <span className="quick-sub">{item.sub}</span>
            </span>
          </button>
        ))}
        <button
          className="quick-card quick-card--local"
          onClick={() => void window.aiOffice.browse().catch(reportError)}
          data-tip={supportedFormats ? supportedFormats.map(ext => `.${ext}`).join(' / ') : OPEN_LOCAL_EXTENSIONS}
        >
          <span className="quick-folder">
            <FolderIcon size={18} />
          </span>
          <span className="quick-text">
            <span className="quick-title-row">
              <span className="quick-title">{t('openLocal')}</span>
            </span>
            <span className="quick-sub">{supportedFormats ? supportedFormats.map(ext => `.${ext}`).join(' / ') : OPEN_LOCAL_EXTENSIONS}</span>
          </span>
        </button>
      </div>
    )
  }

  // ── Sidebar folder tree ──

  const addFolderRoot = () => {
    void window.aiOffice.addFolderRoot().then((added) => {
      if (added) loadRoot()
    }).catch(reportError)
  }

  /** the folder leaves the list only; whatever it held on disk stays where it is */
  const removeFolderRoot = (path: string) => {
    setFolderMenu(null)
    void runAction(`remove-root:${path}`, () => window.aiOffice.removeFolderRoot(path), () => {
      setSelectedFolder((current) => current && isUnder(path, current) ? null : current)
      setExpanded((prev) => new Set([...prev].filter((dir) => !isUnder(path, dir))))
      loadRoot()
    })
  }

  // folders dragged in from the OS join the tree in place; documents open as they do anywhere else
  const panelDropProps = capabilities?.localFolders === false ? {} : {
    onDragOver: (event: ReactDragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'link'
      if (!panelDrop) setPanelDrop(true)
    },
    onDragLeave: (event: ReactDragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setPanelDrop(false)
    },
    onDrop: (event: ReactDragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      setPanelDrop(false)
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => window.aiOffice.pathForFile(file))
        .filter(Boolean)
      if (paths.length === 0) return
      void window.aiOffice.dropFolderRoots(paths).then((added) => {
        if (added.length > 0) loadRoot()
      }).catch(reportError)
    },
  }

  const renderFolderMenu = (entry: { path: string; name: string }, rootEntry?: FolderRoot) => (
    <div
      className="folder-menu-wrap"
      ref={menuOpenAt('tree', entry.path) ? folderMenuWrapRef : undefined}
    >
      <button
        className="folder-more-btn"
        aria-label={t('folderMoreActions', { name: entry.name })}
        aria-expanded={menuOpenAt('tree', entry.path)}
        onClick={(e) => {
          e.stopPropagation()
          folderMenuTrigger.current = e.currentTarget
          if (menuOpenAt('tree', entry.path)) {
            setFolderMenu(null)
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          setFolderMenu({
            path: entry.path,
            where: 'tree',
            x: rect.right,
            y: rect.bottom + 4,
            above: rect.top - 4,
            align: 'end',
          })
        }}
      >
        <MoreDots />
      </button>
      {folderMenu && menuOpenAt('tree', entry.path) && renderMenu(
        <div className={`folder-menu${supportedFormats ? ' home-web-menu' : ''}`} role="menu" ref={folderMenuPopRef} onKeyDown={supportedFormats ? folderMenuKeyDown : undefined}>
          {editableAt(entry.path) && (
            <button role="menuitem" onClick={() => startCreateFolder(entry.path)}>
              {t('newSubfolder')}
            </button>
          )}
          {!rootEntry && editableAt(entry.path) && (
            <button role="menuitem" onClick={() => startRenameFolder(entry, 'tree')}>
              {t('rename')}
            </button>
          )}
          {!rootEntry && editableAt(entry.path) && (
            <button role="menuitem" onClick={() => startMove([entry.path])}>
              {t('moveToFolder')}
            </button>
          )}
          {(rootEntry?.readable ?? true) && (
            <button
              role="menuitem"
              onClick={() => {
                setFolderMenu(null)
                void revealPath(entry.path)
              }}
            >
              {t('revealInFolder')}
            </button>
          )}
          {!rootEntry && editableAt(entry.path) && (
            <>
              <div className="row-menu-divider" />
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  setFolderMenu(null)
                  rememberDialogOpener()
                  setConfirmDeleteFolder({path: entry.path})
                }}
              >
                {t('deleteFolder')}
              </button>
            </>
          )}
          {capabilities?.localFolders !== false && rootEntry?.removable && (
            <>
              <div className="row-menu-divider" />
              <button role="menuitem" onClick={() => removeFolderRoot(entry.path)}>
                {t('removeFolderRoot')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )

  const renderNewFolderInput = (depth: number) => (
    <li className="tree-item">
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="tree-chevron" aria-hidden="true" />
        <span className="tree-icon" aria-hidden="true">
          <FolderIcon />
        </span>
        <input
          className="folder-rename-input inline"
          autoFocus
          placeholder={t('untitledFolder')}
          value={newFolderName}
          disabled={!!creating && pendingActions.has(`create:${creating.parent}`)}
          onChange={(e) => {folderCreateGeneration.current++; setNewFolderName(e.target.value)}}
          onBlur={() => void commitCreateFolder(false)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') void commitCreateFolder()
            if (e.key === 'Escape') {
              folderCreateGeneration.current++
              creatingFolderRef.current = null
              setCreating(null)
              setNewFolderName('')
            }
          }}
        />
      </div>
    </li>
  )

  function renderTreeNode(
    entry: { path: string; name: string; hasSubfolders: boolean },
    depth: number,
  ): ReactElement {
    const rootEntry = roots.find((r) => r.path === entry.path)
    const isRoot = rootEntry !== undefined
    const unavailable = rootEntry !== undefined && !rootEntry.readable
    const isOpen = expanded.has(entry.path) && !unavailable
    const children = listings.get(entry.path)?.folders ?? []
    const isActive = selectedFolder === entry.path
    const isRenaming = folderRenaming?.where === 'tree' && folderRenaming.path === entry.path
    const showChevron = !unavailable && (isRoot || entry.hasSubfolders || children.length > 0)
    return (
      <li key={entry.path} className="tree-item">
        <div
          className={`tree-row${isActive ? ' active' : ''}${dropTarget === entry.path ? ' drop-target' : ''}${unavailable ? ' unavailable' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          role="treeitem"
          aria-selected={isActive}
          aria-expanded={showChevron ? isOpen : undefined}
          tabIndex={0}
          title={isRoot ? entry.path : undefined}
          onClick={() => {
            if (!unavailable) selectFolder(entry.path)
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' && !unavailable) selectFolder(entry.path)
            if (e.key === 'ArrowRight' && !isOpen) toggleExpanded(entry.path)
            if (e.key === 'ArrowLeft' && isOpen) toggleExpanded(entry.path)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            folderMenuTrigger.current = e.currentTarget
            setFolderMenu({
              path: entry.path,
              where: 'tree',
              x: e.clientX + 2,
              y: e.clientY + 2,
              above: e.clientY + 2,
              align: 'start',
            })
          }}
          draggable={!isRoot && !isRenaming}
          onDragStart={(e) => onRowDragStart(e, [entry.path])}
          {...folderDropProps(entry.path, { autoExpand: true })}
        >
          <button
            className="tree-chevron"
            tabIndex={-1}
            aria-hidden="true"
            style={{ visibility: showChevron ? undefined : 'hidden' }}
            onClick={(e) => {
              e.stopPropagation()
              toggleExpanded(entry.path)
            }}
          >
            <Chevron open={isOpen} />
          </button>
          <span className="tree-icon" aria-hidden="true">
            <FolderIcon open={isOpen} />
          </span>
          {isRenaming ? (
            <input
              className="folder-rename-input inline"
              value={folderRenaming.value}
              disabled={pendingActions.has(`rename:${entry.path}`)}
              autoFocus
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                folderRenameGeneration.current++
                setFolderRenaming({ path: entry.path, where: 'tree', value: e.target.value })
              }}
              onBlur={() => void commitRenameFolder(false)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') void commitRenameFolder()
                if (e.key === 'Escape') {folderRenameGeneration.current++; folderRenamingRef.current = null; setFolderRenaming(null)}
              }}
            />
          ) : (
            <span className="tree-name">{entry.name}</span>
          )}
          {unavailable && <span className="tree-hint">{t('rootUnavailable')}</span>}
          {renderFolderMenu(entry, rootEntry)}
        </div>
        {isOpen && (children.length > 0 || creating?.parent === entry.path) && (
          <ul className="tree-children" role="group">
            {creating?.parent === entry.path && renderNewFolderInput(depth + 1)}
            {children.map((child) => renderTreeNode(child, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  function renderFolderPanel() {
    const createIn = selectedFolder ?? root?.path
    const canCreate = createIn !== undefined && rootOf(createIn, roots)?.usable === true
    return (
      <div className={`folder-panel${panelDrop ? ' drop-target' : ''}`} {...panelDropProps}>
        <div className="folder-panel-head">
          <span className="folder-panel-title">{t('folders')}</span>
          <div className="folder-panel-actions">
            {capabilities?.localFolders !== false && roots.length > 0 && (
              <button
                className="folder-add-btn folder-add-root-btn"
                data-tip={t('addFolderRoot')}
                aria-label={t('addFolderRoot')}
                onClick={addFolderRoot}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
                  <path d="M2 13h10" />
                  <path d="m9 16 3-3-3-3" />
                </svg>
              </button>
            )}
            {canCreate && (
              <button
                className="folder-add-btn folder-new-btn"
                data-tip={t('newFolder')}
                aria-label={t('newFolder')}
                onClick={() => startCreateFolder(createIn)}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M7 1v12M1 7h12"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
        <ul className="tree" role="tree">
          {root && !root.usable ? (
            <li className="folder-unusable">
              <p>{t('rootUnusable')}</p>
              {capabilities?.localFolders !== false && <button
                className="btn btn-secondary"
                onClick={() => void window.aiOffice.pickDefaultSaveDir().then(() => loadRoot()).catch(reportError)}
              >
                {t('pickSaveDir')}
              </button>}
            </li>
          ) : (
            root && renderTreeNode({ path: root.path, name: root.name, hasSubfolders: true }, 0)
          )}
          {roots
            .slice(1)
            .map((r) =>
              renderTreeNode({ path: r.path, name: r.name, hasSubfolders: r.readable }, 0),
            )}
        </ul>
      </div>
    )
  }

  // ── File row rendering (shared by the plain view and the folder view) ──

  function renderFileRow(entry: RecentEntry, context: 'global' | 'folder') {
    const isRenaming = renaming?.path === entry.path
    const editable = editableAt(entry.path)
    const canDelete =
      context === 'folder' ? folderSelectedPaths.length === 0 : selectedPaths.length === 0
    return (
      <li className="recent-row" key={entry.path}>
        <div
          className={`recent-item${entry.missing ? ' missing' : ''}`}
          role="button"
          tabIndex={0}
          draggable={!isRenaming && !entry.missing}
          onDragStart={(e) => onRowDragStart(e, dragPathsFor(entry.path, context))}
          onClick={(event) => {
            if (isRenaming) return
            if (entry.missing) {rememberDialogOpener(event.currentTarget); setConfirmMissing(entry)}
            else openPath(entry.path)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target === event.currentTarget) {
              if (entry.missing) {rememberDialogOpener(event.currentTarget); setConfirmMissing(entry)}
              else openPath(entry.path)
            }
          }}
        >
          <span className="col-check" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              className="row-check"
              checked={selected.has(entry.path)}
              onChange={(event) => toggleSelect(entry.path, event.target.checked)}
              aria-label={t('selectFile', { name: entry.name })}
            />
          </span>
          <span className="recent-icon">
            <FileBadge ext={entry.ext} size={24} />
          </span>
          {isRenaming ? (
            <input
              className="rename-input"
              value={renaming.value}
              disabled={pendingActions.has(`rename:${entry.path}`)}
              autoFocus
              onFocus={(event) => event.target.select()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {renameGeneration.current++; setRenaming({ path: entry.path, value: event.target.value })}}
              onBlur={() => commitRename(entry, false)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') commitRename(entry)
                if (event.key === 'Escape') {renameGeneration.current++; renamingRef.current = null; setRenaming(null)}
              }}
            />
          ) : (
            <span className="recent-name">{entry.name}</span>
          )}
          <span className="recent-path" title={(entry.locationLabel ?? locationLabel(entry.path, roots, listings)) || undefined}>
            {(entry.locationLabel ?? locationLabel(entry.path, roots, listings))}
          </span>
          <span className="recent-time">
            {entry.missing ? '—' : formatModified(entry.mtimeMs, i18n)}
          </span>
          <span className="recent-size">{entry.missing ? '—' : formatSize(entry.sizeBytes)}</span>
          <button
            className={`star-btn${entry.starred ? ' starred' : ''}`}
            aria-label={entry.starred ? t('unstar') : t('star')}
            onClick={(event) => {
              event.stopPropagation()
              toggleStar(entry.path)
            }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 1.9l1.9 3.85 4.25.62-3.07 3 .72 4.23L8 11.6l-3.8 2 .72-4.23-3.07-3 4.25-.62z"
                fill={entry.starred ? '#f5a623' : 'none'}
                stroke={entry.starred ? '#f5a623' : 'currentColor'}
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span
            className="recent-actions"
            ref={rowMenu === entry.path ? rowMenuWrapRef : undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="more-btn"
              aria-label={t('moreActions')}
              aria-expanded={rowMenu === entry.path}
              onKeyDown={supportedFormats ? event => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault(); event.stopPropagation()
                rowMenuTrigger.current = event.currentTarget
                rowMenuAnchor.current = event.currentTarget.getBoundingClientRect()
                setRowMenu(entry.path)
              } : undefined}
              onClick={(event) => {
                rowMenuTrigger.current = event.currentTarget
                rowMenuAnchor.current = event.currentTarget.getBoundingClientRect()
                setRowMenu(rowMenu === entry.path ? null : entry.path)
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="3.2" cy="8" r="1.4" fill="currentColor" />
                <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                <circle cx="12.8" cy="8" r="1.4" fill="currentColor" />
              </svg>
            </button>
            {rowMenu === entry.path && renderMenu(
              <div className={`row-menu${supportedFormats ? ' home-web-menu' : ''}`} role="menu" onKeyDown={supportedFormats ? event => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                  if (event.key === 'Escape') event.preventDefault()
                  event.stopPropagation()
                  rowMenuTrigger.current?.focus({preventScroll: true})
                  setRowMenu(null)
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault(); event.stopPropagation()
                  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
                  const index = items.indexOf(document.activeElement as HTMLButtonElement)
                  items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus({preventScroll: true})
                }
              } : undefined} ref={rowMenuPopRef} style={supportedFormats ? {position: 'fixed', right: 'auto', bottom: 'auto', zIndex: 1200} : undefined}>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null)
                    openPath(entry.path)
                  }}
                >
                  {t('open')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null)
                    void revealPath(entry.path)
                  }}
                >
                  {t('revealInFolder')}
                </button>
                {capabilities?.copyPath !== false && <button
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null)
                    void navigator.clipboard.writeText(entry.path).catch(reportError)
                  }}
                >
                  {t('copyPath')}
                </button>}
                {canMove && editable && !entry.missing && (
                  <>
                    <div className="row-menu-divider" />
                    <button role="menuitem" onClick={() => startMove([entry.path])}>
                      {t('moveToFolder')}
                    </button>
                  </>
                )}
                {editable && (
                  <>
                    <div className="row-menu-divider" />
                    <button role="menuitem" onClick={() => startRename(entry)}>
                      {t('rename')}
                    </button>
                    {capabilities?.duplicateFile !== false && <button role="menuitem" onClick={() => duplicateFile(entry.path)}>
                      {t('duplicate')}
                    </button>}
                  </>
                )}
                {capabilities?.starredGroups !== false && entry.starred && (
                  <>
                    <div className="row-menu-divider" />
                    <button
                      role="menuitem"
                      onClick={() => {
                        setRowMenu(null)
                        setGroupPicker([entry.path])
                      }}
                    >
                      {t('moveToGroup')}
                    </button>
                  </>
                )}
                {canDelete && (context === 'global' || editable) && (
                  <>
                    <div className="row-menu-divider" />
                    {context === 'global' &&
                      // same root cause as the selection bar: in the Starred
                      // view "remove from list" must unstar, not drop recents
                      (view === 'starred' ? (
                        <button role="menuitem" onClick={() => unstarSelected([entry.path])}>
                          {t('unstar')}
                        </button>
                      ) : (
                        <button role="menuitem" onClick={() => removeRecent([entry.path])}>
                          {t('removeFromList')}
                        </button>
                      ))}
                    {editable && (
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() => deleteFiles([entry.path])}
                      >
                        {t('deleteFiles')}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </span>
        </div>
      </li>
    )
  }

  /** sub-folder row in the folder view's table: enter on click, same … menu as the tree */
  function renderSubfolderRow(entry: FolderEntry) {
    const isRenaming = folderRenaming?.where === 'table' && folderRenaming.path === entry.path
    const editable = editableAt(entry.path)
    return (
      <li className="recent-row" key={entry.path}>
        <div
          className={`recent-item folder-item${dropTarget === entry.path ? ' drop-target' : ''}`}
          role="button"
          tabIndex={0}
          draggable={!isRenaming}
          onDragStart={(e) => onRowDragStart(e, [entry.path])}
          {...folderDropProps(entry.path, { autoExpand: false })}
          onClick={() => {
            if (isRenaming) return
            expandTo(entry.path)
            selectFolder(entry.path)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target === event.currentTarget) {
              expandTo(entry.path)
              selectFolder(entry.path)
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            folderMenuTrigger.current = e.currentTarget
            setFolderMenu({
              path: entry.path,
              where: 'table',
              x: e.clientX + 2,
              y: e.clientY + 2,
              above: e.clientY + 2,
              align: 'start',
            })
          }}
        >
          <span className="col-check" aria-hidden="true" />
          <span className="recent-icon folder-badge">
            <FolderIcon size={22} />
          </span>
          {isRenaming ? (
            <input
              className="rename-input"
              value={folderRenaming.value}
              disabled={pendingActions.has(`rename:${entry.path}`)}
              autoFocus
              onFocus={(event) => event.target.select()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                folderRenameGeneration.current++
                setFolderRenaming({ path: entry.path, where: 'table', value: event.target.value })
              }}
              onBlur={() => void commitRenameFolder(false)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') void commitRenameFolder()
                if (event.key === 'Escape') {folderRenameGeneration.current++; folderRenamingRef.current = null; setFolderRenaming(null)}
              }}
            />
          ) : (
            <span className="recent-name">{entry.name}</span>
          )}
          <span className="recent-path">{t('folderType')}</span>
          <span className="recent-time">{formatModified(entry.mtimeMs, i18n)}</span>
          <span className="recent-size">—</span>
          <span />
          <span
            className="recent-actions"
            ref={menuOpenAt('table', entry.path) ? folderMenuWrapRef : undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="more-btn"
              aria-label={t('folderMoreActions', { name: entry.name })}
              aria-expanded={menuOpenAt('table', entry.path)}
              onClick={(e) => {
                folderMenuTrigger.current = e.currentTarget
                if (menuOpenAt('table', entry.path)) {
                  setFolderMenu(null)
                  return
                }
                const rect = e.currentTarget.getBoundingClientRect()
                setFolderMenu({
                  path: entry.path,
                  where: 'table',
                  x: rect.right,
                  y: rect.bottom + 4,
                  above: rect.top - 4,
                  align: 'end',
                })
              }}
            >
              <MoreDots />
            </button>
            {folderMenu && menuOpenAt('table', entry.path) && renderMenu(
              <div className={`folder-menu${supportedFormats ? ' home-web-menu' : ''}`} role="menu" ref={folderMenuPopRef} onKeyDown={supportedFormats ? folderMenuKeyDown : undefined}>
                <button
                  role="menuitem"
                  onClick={() => {
                    setFolderMenu(null)
                    expandTo(entry.path)
                    selectFolder(entry.path)
                  }}
                >
                  {t('open')}
                </button>
                {editable && (
                  <>
                    <button role="menuitem" onClick={() => startRenameFolder(entry, 'table')}>
                      {t('rename')}
                    </button>
                    <button role="menuitem" onClick={() => startMove([entry.path])}>
                      {t('moveToFolder')}
                    </button>
                  </>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    setFolderMenu(null)
                    void revealPath(entry.path)
                  }}
                >
                  {t('revealInFolder')}
                </button>
                {editable && (
                  <>
                    <div className="row-menu-divider" />
                    <button
                      role="menuitem"
                      className="danger"
                      onClick={() => {
                        setFolderMenu(null)
                        rememberDialogOpener()
                        setConfirmDeleteFolder({path: entry.path})
                      }}
                    >
                      {t('deleteFolder')}
                    </button>
                  </>
                )}
              </div>
            )}
          </span>
        </div>
      </li>
    )
  }

  const renderEmpty = (hint: string) => (
    <p className="empty proj-empty">
      <svg
        className="proj-empty-icon"
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M6.29297 3.75H14.1729C14.4927 3.75 14.7979 3.88392 15.0146 4.11914L18.5566 7.96387C18.7512 8.17512 18.8593 8.45208 18.8594 8.73926V19.1055C18.8593 19.7376 18.346 20.25 17.7139 20.25H6.29297C5.66091 20.2499 5.14855 19.7375 5.14844 19.1055V4.89453C5.14855 4.26247 5.66091 3.75011 6.29297 3.75Z"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M13.8984 4V7.11C13.8984 8.15382 14.7446 9 15.7884 9H18.8984"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
      <span className="empty-hint">{hint}</span>
    </p>
  )

  // ── Folder view ────────────────────────────────────────

  const clearSearch = () => {
    cancelReveal()
    setSearchQuery('')
    searchInputRef.current?.focus()
  }

  const renderSearchSettingsButton = () => capabilities?.semanticRanking === false ? null : (
    <button
      className="file-search-settings"
      title={t('searchJevSettings')}
      aria-label={t('searchJevSettings')}
      onClick={() => setSettingsRequest({ section: 'aiMedia', block: 'rerank' })}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 20V4M12 4l-4 4M12 4l4 4" />
        <path d="M3 12h6M3 16h5M3 20h4" />
      </svg>
    </button>
  )

  const renderSearchBox = () => (
    <div className={`file-search${searchActive ? ' active' : ''}`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
        <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={searchInputRef}
        type="search"
        value={searchQuery}
        placeholder={t('searchFilesPlaceholder')}
        aria-label={t('searchFilesPlaceholder')}
        spellCheck={false}
        onChange={(e) => {cancelReveal(); setSearchQuery(e.target.value)}}
        onCompositionStart={() => {
          cancelReveal()
          composingRef.current = true
        }}
        onCompositionEnd={(e) => {
          cancelReveal()
          composingRef.current = false
          setSearchQuery(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && searchQuery) {
            e.stopPropagation()
            clearSearch()
          }
        }}
      />
      {searchQuery && (
        <button className="file-search-clear" aria-label={t('searchClear')} onClick={clearSearch}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M2 2l8 8M10 2l-8 8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  )

  const renderSearchRow = (hit: FileSearchHit) => (
    <li
      key={hit.path}
      className="search-row"
      role="button"
      tabIndex={0}
      onClick={() => openPath(hit.path)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (!e.repeat) openPath(hit.path)
        }
      }}
    >
      <span className="recent-icon">
        <FileBadge ext={hit.ext} size={24} />
      </span>
      <div className="search-main">
        <div className="search-head">
          <span className="search-name">{highlightText(hit.name, hit.needles)}</span>
          <span className="search-path" title={(hit.locationLabel ?? locationLabel(hit.path, roots, listings)) || undefined}>
            {highlightText((hit.locationLabel ?? locationLabel(hit.path, roots, listings)), hit.needles)}
          </span>
        </div>
        {hit.snippet && (
          <p className="search-snippet">
            {hit.snippet.map((part, i) =>
              part.hit ? (
                <mark key={i} className="search-hit">
                  {part.text}
                </mark>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )}
          </p>
        )}
      </div>
      <span className="search-time">{formatModified(hit.mtimeMs, i18n)}</span>
    </li>
  )

  const renderSearchResults = () => {
    const page = searchPage
    const busy = !searchError && !!page && (page.index.pending > 0 || page.index.scanning)
    return (
      <div className="search-results" aria-live="polite">
        {!page && !searchError && <div className="load-more" role="status" aria-busy="true" aria-label={t('cloudRefresh')}><span className="load-more-spinner" /></div>}
        {searchError && <div className="empty"><span className="empty-hint" role="alert">{searchError}</span><button className="btn btn-secondary" onClick={() => setSearchRefresh(value => value + 1)}>{t('cloudRetry')}</button></div>}
        {busy && (
          <div className="search-status">
            <span className="load-more-spinner" />
            {t('searchIndexing', { n: page.index.pending })}
          </div>
        )}
        {page && page.hits.length === 0 && !busy && !searchError
          ? renderEmpty(t('searchNoResults', { q }))
          : page && (
              <>
                <ul className="search-list">{orderedSearchHits(page.hits).map(renderSearchRow)}</ul>
                {!busy && !searchError && page.hits.length < page.total && <button className="btn btn-secondary search-more" disabled={searchMoreBusy} aria-busy={searchMoreBusy} onClick={() => void loadMoreSearch()}>{t('searchMore')}</button>}
              </>
            )}
      </div>
    )
  }

  const rerankApplied = rerank && rerank.key === rerankKey ? rerank.result : null

  /** judged hits in Jev's order, then the rest in local order */
  const orderedSearchHits = (hits: readonly FileSearchHit[]): FileSearchHit[] => {
    if (!rerankApplied) return [...hits]
    const rank = new Map(rerankApplied.order.map((path, i) => [path, i]))
    return [...hits].sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity))
  }

  const renderSearchHeading = () => {
    const total = searchPage?.total ?? 0
    return (
      <div className="recents-heading">
        {rerankApplied && (
          <span className="search-rerank-badge" title={t('searchRerankedBy')}>
            Jev
          </span>
        )}
        {searchPage && !searchError && <span className="file-count">
          {t(total === 1 ? 'searchResultCountOne' : 'searchResultCount', { n: total })}
        </span>}
      </div>
    )
  }

  const renderActionError = () => actionError && <div className="home-action-error" role="alert"><span>{actionError}</span><button className="btn btn-secondary" onClick={() => setActionError('')}>{t('cancel')}</button></div>

  function renderFolderContent() {
    if (roots.length === 0) return null
    const total = folderSubfolders.length + folderFiles.length
    return (
      <main className="content">
        {!confirmDelete && !confirmDeleteFolder && !movePicker && renderActionError()}
        <section className="quick-start" aria-label={t('secQuickStart')}>
          <div className="section-head">
            <span className="section-label">{t('secQuickStart')}</span>
          </div>
          {renderQuickCards()}
        </section>

        <section className="recents" aria-label={t('folders')}>
          <div className="recents-toolbar">
            {folderSelectedPaths.length > 0 ? (
              <div className="selection-bar">
                <span className="selection-count">
                  {t('selectedCount', { n: folderSelectedPaths.length })}
                </span>
                {selectedFolder && editableAt(selectedFolder) && (
                  <>
                    <button
                      className="selection-action"
                      onClick={() => startMove(folderSelectedPaths)}
                    >
                      {t('moveToFolder')}
                    </button>
                    <button
                      className="selection-action danger"
                      onClick={() => deleteFiles(folderSelectedPaths)}
                    >
                      {t('deleteFiles')}
                    </button>
                  </>
                )}
                <button className="selection-action" onClick={() => setSelected(new Set())}>
                  {t('cancel')}
                </button>
              </div>
            ) : (
              <div className="filter-pills" role="tablist" aria-label={t('filterAria')}>
                {FILTERS.filter(f => !supportedFormats || f.key === 'all' || supportedFormats.includes(f.key)).map((f) => (
                  <button
                    key={f.key}
                    className={`filter-pill${filter === f.key ? ' active' : ''}`}
                    onClick={() => changeFilter(f.key)}
                  >
                    {t(f.label)}
                  </button>
                ))}
              </div>
            )}
            <div className="file-search-group">
              {renderSearchBox()}
              {renderSearchSettingsButton()}
            </div>
            {searchActive ? (
              renderSearchHeading()
            ) : (
              <div className="recents-heading folder-heading">
                <span className="file-count">
                  {t(total === 1 ? 'itemCountOne' : 'itemCount', { n: total })}
                </span>
              </div>
            )}
          </div>

          {searchActive ? (
            renderSearchResults()
          ) : total === 0 ? (
            renderEmpty(filter === 'all' ? t('emptyFolder') : t('emptyFiltered'))
          ) : (
            <><div ref={tableRef}
              className={`recent-table${folderSelectedPaths.length > 0 ? ' has-selection' : ''}`}
            >
              <div className="recent-columns">
                <span className="col-check">
                  <input
                    type="checkbox"
                    checked={folderAllSelected}
                    ref={(node) => { if (node) node.indeterminate = !folderAllSelected && visibleFolderFiles.some(entry => selected.has(entry.path)) }}
                    aria-checked={!folderAllSelected && visibleFolderFiles.some(entry => selected.has(entry.path)) ? 'mixed' : folderAllSelected}
                    disabled={visibleFolderFiles.length === 0}
                    onChange={toggleSelectAllFolder}
                    aria-label={t('selectAll')}
                  />
                </span>
                <span className="col-name">{t('colName')}</span>
                <span className="col-path">{t('colLocation')}</span>
                {renderModifiedHeader()}
                <span className="col-size">{t('colSize')}</span>
                <span />
                <span />
              </div>
              <ul className="recent-list">
                {visibleSubfolders.map((entry) => renderSubfolderRow(entry))}
                {visibleFolderFiles.map((entry) => renderFileRow(entry, 'folder'))}
              </ul>
            </div>{renderFilePager(currentFolderPage, total, changeFolderPage)}</>
          )}
        </section>
      </main>
    )
  }

  // ── Plain view ────────────────────────────────────────

  function renderGlobalContent() {
    const now = new Date()
    const hour = now.getHours()
    const greetKey =
      hour < 6
        ? 'greetEvening'
        : hour < 12
          ? 'greetMorning'
          : hour < 18
            ? 'greetAfternoon'
            : 'greetEvening'
    const cjk = lang === 'zh' || lang === 'zh-TW' || lang === 'ja'
    const greeting = `${t(greetKey)}${accountName ? (cjk ? '，' : ', ') + accountName : ''}${cjk ? '。' : '. '}`
    return (
      <main className="content">
        {!confirmDelete && !confirmDeleteFolder && !movePicker && renderActionError()}
        <section className="quick-start" aria-label={t('secQuickStart')}>
          <div className="home-hero">
            {renderHero?renderHero({greeting,guidance:t(greetAskKey),language:lang}):<h1 className="hero-title">
              {greeting}
              <span className="hero-ask">{t(greetAskKey)}</span>
            </h1>}
          </div>
          {renderQuickCards()}
        </section>

        <section
          className="recents"
          aria-label={view === 'recent' ? t('secRecent') : t('secStarred')}
        >
          <div className="recents-toolbar">
            {selectedPaths.length > 0 ? (
              <div className="selection-bar">
                <span className="selection-count">
                  {t('selectedCount', { n: selectedPaths.length })}
                </span>
                {canMove && (
                  <button className="selection-action" onClick={() => startMove(selectedPaths)}>
                    {t('moveToFolder')}
                  </button>
                )}
                {view === 'starred' ? (
                  // every Starred-view row is a favorite, so the selection
                  // action unstars; removeRecent there kept the stars and the
                  // rows came straight back on refresh
                  <button
                    className="selection-action"
                    onClick={() => unstarSelected(selectedPaths)}
                  >
                    {t('unstar')}
                  </button>
                ) : (
                  <button className="selection-action" onClick={() => removeRecent(selectedPaths)}>
                    {t('removeFromList')}
                  </button>
                )}
                <button
                  className="selection-action danger"
                  onClick={() => deleteFiles(selectedPaths)}
                >
                  {t('deleteFiles')}
                </button>
                <button className="selection-action" onClick={() => setSelected(new Set())}>
                  {t('cancel')}
                </button>
              </div>
            ) : (
              <div className="toolbar-filters">
                <div className="filter-pills" role="tablist" aria-label={t('filterAria')}>
                  {FILTERS.filter(f => !supportedFormats || f.key === 'all' || supportedFormats.includes(f.key)).map((f) => (
                    <button
                      key={f.key}
                      className={`filter-pill${filter === f.key ? ' active' : ''}`}
                      onClick={() => changeFilter(f.key)}
                    >
                      {t(f.label)}
                    </button>
                  ))}
                </div>
                {capabilities?.starredGroups !== false && view === 'starred' && starredGroups.length > 0 && (
                  // the group pills refine the Starred view further; the type
                  // pills above them keep working on the group-scoped list
                  <div className="filter-pills" role="tablist" aria-label={t('groupFilterAria')}>
                    <button
                      className={`filter-pill${groupFilter === null ? ' active' : ''}`}
                      onClick={() => changeGroupFilter(null)}
                    >
                      {t('filterAll')}
                    </button>
                    {starredGroups.map((g) => (
                      <button
                        key={g}
                        className={`filter-pill${groupFilter === g ? ' active' : ''}`}
                        onClick={() => changeGroupFilter(g)}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="file-search-group">
              {renderSearchBox()}
              {renderSearchSettingsButton()}
            </div>
            {searchActive ? (
              renderSearchHeading()
            ) : (
              <div className="recents-heading">
                <span className="section-label">
                  {view === 'recent' ? t('secRecent') : t('secStarred')}
                </span>
                <span className="file-count">{fileCountLabel(listTotal, lang, t)}</span>
              </div>
            )}
          </div>

          {searchActive ? (
            renderSearchResults()
          ) : entries.length === 0 && listLoading ? (
            <div className="load-more" role="status" aria-busy="true" aria-label={t('cloudRefresh')}>
              <span className="load-more-spinner" />
            </div>
          ) : entries.length === 0 && listError ? (
            <div className="empty">
              <span className="empty-hint" role="alert">{listError}</span>
              <button className="btn btn-secondary" onClick={() => reloadRef.current(false)}>{t('cloudRetry')}</button>
            </div>
          ) : entries.length === 0 ? (
            renderEmpty(
              view === 'starred'
                ? t('emptyStarred')
                : navCounts.recent === 0
                  ? t('emptyRecent')
                  : t('emptyFiltered'),
            )
          ) : (
            <><div ref={tableRef} aria-busy={listLoading} inert={listLoading ? true : undefined} className={`recent-table${selectedPaths.length > 0 ? ' has-selection' : ''}`}>
              <div className="recent-columns">
                <span className="col-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(node) => { if (node) node.indeterminate = !allSelected && selectedPaths.length > 0 }}
                    aria-checked={!allSelected && selectedPaths.length > 0 ? 'mixed' : allSelected}
                    onChange={toggleSelectAll}
                    aria-label={t('selectAll')}
                  />
                </span>
                <span className="col-name">{t('colName')}</span>
                <span className="col-path">{t('colLocation')}</span>
                {renderModifiedHeader()}
                <span className="col-size">{t('colSize')}</span>
                <span />
                <span />
              </div>
              <ul className="recent-list">
                {(!capabilities?.serverFileSort && fileSort === 'oldest' ? [...entries].reverse() : entries).map((entry) =>
                  renderFileRow(entry, 'global'),
                )}
                {hasMore && (
                  <li ref={sentinelRef} className="load-more" aria-hidden="true">
                    <span className="load-more-spinner" />
                  </li>
                )}
              </ul>
            </div>{renderFilePager(webPage, listTotal, changeWebPage, listLoading)}</>
          )}
        </section>
      </main>
    )
  }

  const movingDirs = (paths: string[]) =>
    paths.filter((p) => {
      // a folder being moved: its own listing is cached, or it is a known sub-folder
      if (listings.has(p)) return true
      const parent = listings.get(dirOf(p))
      return parent?.folders.some((f) => f.path === p) ?? false
    })

  const activeNav = !selectedFolder && !cloudMode ? view : null

  const onSidebarResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startX = e.clientX
    const startW = sidebarRef.current?.getBoundingClientRect().width ?? SIDEBAR_MIN_WIDTH
    const sign = getComputedStyle(e.currentTarget).direction === 'rtl' ? -1 : 1
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let next = startW
    const move = (ev: PointerEvent) => {
      next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startW + sign * (ev.clientX - startX)),
      )
      setSidebarWidth(next)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(next)))
      } catch {
        // quota / private mode: the width lasts for this session only
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className={supportedFormats ? 'home home-web' : 'home'}>
      <aside
        className="sidebar"
        ref={sidebarRef}
        style={sidebarWidth === null ? undefined : { width: sidebarWidth }}
      >
        <div className="sidebar-logo">
          <img className="logo-lockup" src={logoLockup} alt="DyOffice" />
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item${activeNav === 'recent' ? ' active' : ''}`}
            aria-current={activeNav === 'recent' ? 'page' : undefined}
            onClick={() => changeView('recent')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M8 4.8V8l2.2 1.6"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
            <span className="nav-label">{t('navRecent')}</span>
            <span className="nav-count">{navCounts.recent}</span>
          </button>
          <button
            className={`nav-item${activeNav === 'starred' ? ' active' : ''}`}
            aria-current={activeNav === 'starred' ? 'page' : undefined}
            onClick={() => changeView('starred')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 1.9l1.9 3.85 4.25.62-3.07 3 .72 4.23L8 11.6l-3.8 2 .72-4.23-3.07-3 4.25-.62z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
            <span className="nav-label">{t('navStarred')}</span>
            <span className="nav-count">{navCounts.starred}</span>
          </button>
          {capabilities?.cloudProjects !== false && loggedIn && (
            <button
              className={`nav-item${cloudMode && !selectedFolder ? ' active' : ''}`}
              onClick={() => {
                cancelReveal()
                setCloudMode(true)
                setSelectedFolder(null)
                setSelected(new Set())
                setRowMenu(null)
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 1.8l1.55 4.65L14.2 8l-4.65 1.55L8 14.2 6.45 9.55 1.8 8l4.65-1.55z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="nav-label">{t('navCloud')}</span>
              <svg
                className="nav-external"
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M6.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13.5h7A1.5 1.5 0 0 0 12.5 12V9.5M9.5 2.5h4v4M13 3l-5.5 5.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </nav>
        <div className="sidebar-divider" />
        {renderFolderPanel()}
        {accountEntry ?? <AccountEntry
          onStatusChange={handleAccountStatus}
          onFileSearchSettingsChange={() => setRerankSettingsTick((n) => n + 1)}
          openRequest={settingsRequest}
        />}
      </aside>
      <div className="sidebar-resizer" onPointerDown={onSidebarResizeStart} />
      {selectedFolder && rootOf(selectedFolder, roots)?.readable ? (
        renderFolderContent()
      ) : cloudMode ? (
        <CloudProjectsView />
      ) : (
        renderGlobalContent()
      )}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('deleteModalTitle')}
            ref={confirmationRef}
            onClick={(event) => event.stopPropagation()}
          >
            <h3>{t('deleteModalTitle')}</h3>
            <p>
              {confirmDelete.length === 1
                ? t('deleteConfirmOne', { name: displayName(confirmDelete[0]) })
                : t('deleteConfirmMany', { n: confirmDelete.length })}
            </p>
            {confirmDelete.length > 1 && (
              <ul className="modal-file-list">
                {confirmDelete.map((p) => (
                  <li key={p} title={displayName(p)}>{displayName(p)}</li>
                ))}
              </ul>
            )}
            {actionError && <p className="home-action-error" role="alert">{actionError}</p>}
            <div className="modal-buttons">
              <button
                className="btn btn-secondary"
                autoFocus
                onClick={() => setConfirmDelete(null)}
              >
                {t('cancel')}
              </button>
              <button className="btn btn-danger" disabled={pendingActions.has(`delete:${confirmDelete.join('\n')}`)} onClick={confirmDeleteNow}>
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteFolder && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteFolder(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('deleteFolderTitle')}
            ref={confirmationRef}
            onClick={(event) => event.stopPropagation()}
          >
            <h3>{t('deleteFolderTitle')}</h3>
            <p>{folderDeleteDescription?.(displayName(confirmDeleteFolder.path)) ?? t('deleteFolderConfirm', { name: displayName(confirmDeleteFolder.path) })}</p>
            {renderActionError()}
            <div className="modal-buttons">
              <button
                className="btn btn-secondary"
                autoFocus
                onClick={() => setConfirmDeleteFolder(null)}
              >
                {t('cancel')}
              </button>
              <button className="btn btn-danger" disabled={pendingActions.has(`delete-folder:${confirmDeleteFolder.path}`)} onClick={() => void confirmDeleteFolderNow()}>
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmMissing && (
        <div className="modal-overlay" onClick={() => setConfirmMissing(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('missingFileTitle')}
            ref={confirmationRef}
            onClick={(event) => event.stopPropagation()}
          >
            <h3>{t('missingFileTitle')}</h3>
            <p>{t('missingFileBody', { name: confirmMissing.name })}</p>
            <div className="modal-buttons">
              <button
                className="btn btn-secondary"
                autoFocus
                onClick={() => setConfirmMissing(null)}
              >
                {t('cancel')}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  // main drops the star of an unavailable entry with the row
                  removeRecent([confirmMissing.path])
                  setConfirmMissing(null)
                }}
              >
                {t('removeFromList')}
              </button>
            </div>
          </div>
        </div>
      )}

      {movePicker && canMove && (
        <FolderPicker
          roots={roots}
          currentDirs={new Set(movePicker.map((path) => loadedParent(path, listings)))}
          movingDirs={movingDirs(movePicker)}
          count={movePicker.length}
          onCancel={() => setMovePicker(null)}
          onPick={(dir) => void doMove(movePicker, dir, 'ask')}
          operationFailure={actionError}
        />
      )}

      {capabilities?.starredGroups !== false && groupPicker && (
        <GroupPicker
          groups={starredGroups}
          count={groupPicker.length}
          onCancel={() => setGroupPicker(null)}
          onPick={(group) => assignGroup(groupPicker, group)}
          onCreate={(name) => assignGroup(groupPicker, name)}
          onRemove={() => assignGroup(groupPicker, null)}
        />
      )}

      {conflict && (
        <ConflictPrompt
          names={conflict.paths.map(displayName)}
          onChoose={(policy) => {
            if (policy === 'skip') setConflict(null)
            else void doMove(conflict.paths, conflict.targetDir, policy)
          }}
        />
      )}

      <DropToOpenOverlay />
    </div>
  )
}
