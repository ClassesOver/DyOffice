/**
 * PDF export pages: every visible slide as vector SVG (text stays text), with
 * the whole-page PNG raster as the safety net for a page the SVG backend
 * cannot build, plus the @font-face CSS the print window needs for them.
 */
import type { RenderSlide } from '@genoffice/pptx-render'
import type { ExportPdfPage } from '../shared/ipc'
import { collectExportFontCss } from './export-fonts'
import { rasterizeSlideNode, renderSlidesToPngBase64 } from './export-render'
import { renderSlideToSvg } from './export-svg'

export interface PdfExportPages {
  pages: ExportPdfPage[]
  fontCss: string
}

export async function renderSlidesToPdfPages(
  slides: RenderSlide[],
  images: Map<string, HTMLImageElement>,
  maxOutputChars = Infinity,
): Promise<PdfExportPages> {
  const pages: ExportPdfPage[] = []
  const fonts = new Set<string>()
  let outputChars = 0
  for (const [i, slide] of slides.entries()) {
    let content: ExportPdfPage
    try {
      const page = await renderSlideToSvg(slide, images, {
        rasterizeNode: (node) => rasterizeSlideNode(node, slide, images),
        idPrefix: `p${i + 1}-`,
      })
      for (const f of page.fontFamilies) fonts.add(f)
      content = { svg: page.svg }
    } catch {
      const [png] = await renderSlidesToPngBase64([slide], images)
      content = { png: png ?? '' }
    }
    outputChars += 'svg' in content ? content.svg.length : content.png.length
    if (outputChars > maxOutputChars) throw new Error('PDF export exceeds its size limit.')
    pages.push(content)
  }
  let fontCss = ''
  try {
    fontCss = await collectExportFontCss(fonts)
  } catch {
    // no embedded faces: the print window falls back to the CSS chains' system fonts
  }
  if (outputChars + fontCss.length > maxOutputChars) throw new Error('PDF export exceeds its size limit.')
  return { pages, fontCss }
}
