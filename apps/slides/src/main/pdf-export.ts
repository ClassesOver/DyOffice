import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExportPdfLink, ExportPdfPage } from '../shared/ipc'
import { printPageSizeIn } from '../shared/print-html'
import { buildPdfExportHtml } from '../shared/pdf-export-html'

export interface PdfExportWindow {
  loadFile(path: string): Promise<void>
  webContents: {
    executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>
    printToPDF(options: Electron.PrintToPDFOptions): Promise<Buffer>
  }
  destroy(): void
}

export interface ExportSlidesPdfOptions {
  pages: ExportPdfPage[]
  widthPx: number
  heightPx: number
  filePath: string
  /** Per-page clickable link overlays (fractions of the page box), same order as pages */
  links?: ExportPdfLink[][]
  /** @font-face rules for the SVG pages' text (data: URLs) */
  fontCss?: string
  createWindow(): PdfExportWindow
  openExportedPdf(path: string): void
  /** Watchdog for a hung renderer (default 300s, matching the headless export) */
  timeoutMs?: number
}

export interface ExportSlidesPdfResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * Fonts and every bitmap decoded before printing, or pages print blank. SVG
 * `<image>` elements are not in document.images: decoding the same data URL
 * through an Image primes the shared cache, and two frames let the SVG pick
 * it up.
 */
export const PRINT_READY_SCRIPT = `Promise.all([
  document.fonts.ready,
  ...Array.from(document.images).map((i) => i.decode().catch(() => {})),
  ...Array.from(document.querySelectorAll('svg image')).map((el) => {
    const href = el.getAttribute('href') || el.getAttribute('xlink:href')
    if (!href) return Promise.resolve()
    const img = new Image()
    img.src = href
    return img.decode().catch(() => {})
  }),
]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`

/** PDF page size: fixed 7.5in height, width by slide ratio (16:9 -> 13.333in, 4:3 -> 10in).
    Rendered dimensions can be zeroed by a failed capture or non-finite from a
    degenerate transform; dividing them raw yields NaN/Infinity/0in pages, so
    the ratio is normalized to the same bounds as the print path. */
export function exportPageWidthIn(widthPx: number, heightPx: number): number {
  return exportPaperSize(widthPx, heightPx).width
}

function exportPaperSize(widthPx: number, heightPx: number) {
  return printPageSizeIn('full', undefined, heightPx > 0 ? widthPx / heightPx : NaN)
}

/** Hidden export window watchdog: a renderer that never settles (a stuck font
 * or bitmap, a wedged print job) must fail the export instead of spinning the
 * button forever and leaking the hidden window + temp dir on every retry.
 * Same budget as the headless export in slides-main.ts. */
export const PDF_EXPORT_TIMEOUT_MS = 300_000

/** Export rendered slide pages via an app-owned temporary HTML file. */
export async function exportSlidesPdf({
  pages,
  widthPx,
  heightPx,
  filePath,
  links,
  fontCss,
  createWindow,
  openExportedPdf,
  timeoutMs = PDF_EXPORT_TIMEOUT_MS,
}: ExportSlidesPdfOptions): Promise<ExportSlidesPdfResult> {
  // PDF page size: fixed 7.5in height, width by slide ratio (16:9 -> 13.333in, 4:3 -> 10in)
  const { width: widthIn, height: heightIn } = exportPaperSize(widthPx, heightPx)
  const win = createWindow()
  let tempDir: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'genoffice-slides-pdf-'))
    const htmlPath = join(tempDir, 'slides.html')
    await writeFile(htmlPath, buildPdfExportHtml(pages, widthIn, heightIn, links, fontCss), 'utf8')
    const result = await Promise.race([
      (async (): Promise<ExportSlidesPdfResult> => {
        await win.loadFile(htmlPath)
        await win.webContents.executeJavaScript(PRINT_READY_SCRIPT, true)
        const pdf = await win.webContents.printToPDF({
          landscape: false, // The page size is already landscape (width > height); passing landscape would rotate a second time
          printBackground: true,
          pageSize: { width: widthIn, height: heightIn },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          preferCSSPageSize: false,
        })
        await writeFile(filePath, pdf)
        openExportedPdf(filePath)
        return { ok: true, path: filePath }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`slides PDF export timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
    return result
  } catch (err) {
    return { ok: false, error: String(err) }
  } finally {
    if (timer) clearTimeout(timer)
    try {
      win.destroy()
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true })
    }
  }
}
