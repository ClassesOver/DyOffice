import { Editor } from '@tiptap/core'
import { parseDocx, readSections } from '@genoffice/docx-engine'
import { blocksToPmDoc } from './editor/convert'
import { editorExtensions } from './editor/extensions'
import { documentToMarkdown } from './export-markdown'
import { buildStandaloneHtml } from './html-export'

/** The editor normally draws these details through its stylesheet. */
function inlineHeadlessStyles(root: HTMLElement): void {
  for (const item of root.querySelectorAll<HTMLElement>('.doc-li[data-marker]')) {
    const marker = item.dataset.marker
    if (marker) item.prepend(item.ownerDocument.createTextNode(`${marker}\u00a0`))
  }
  for (const block of root.querySelectorAll<HTMLElement>('[style*="--doc-strut:"]')) {
    const strut = block.style.getPropertyValue('--doc-strut')
    if (strut && block.style.fontSize === 'var(--doc-strut)') block.style.fontSize = strut
  }
  for (const table of root.querySelectorAll<HTMLTableElement>('table.doc-table')) {
    const rows = Array.from(table.rows)
    for (const [rowIndex, row] of rows.entries()) {
      const cells = Array.from(row.cells)
      for (const [columnIndex, cell] of cells.entries()) {
        const sides = [
          ['top', rowIndex === 0 ? 't' : 'h', 'h'],
          ['bottom', rowIndex + cell.rowSpan >= rows.length ? 'b' : 'h', 'h'],
          ['left', columnIndex === 0 ? 'l' : 'v', 'v'],
          ['right', columnIndex === cells.length - 1 ? 'r' : 'v', 'v'],
        ] as const
        for (const [side, edge, inside] of sides) {
          const property = `border-${side}`
          const border = table.style.getPropertyValue(`--doc-b-${edge}`) ||
            table.style.getPropertyValue(`--doc-b-${inside}`)
          if (border && !cell.style.getPropertyValue(property)) cell.style.setProperty(property, border)
        }
      }
    }
  }
}

/** The headless caller initializes the DOM before importing this module. */
export async function exportReconstructedDocx(
  bytes: Uint8Array,
  format: 'md' | 'html',
  title: string,
): Promise<string> {
  const doc = await parseDocx(bytes)
  const sections = readSections(doc)
  const root = document.body.appendChild(document.createElement('div'))
  let editor: Editor | undefined
  try {
    editor = new Editor({ element: root, extensions: editorExtensions })
    editor.storage.listNumbering.styles = doc.styles
    editor.storage.listNumbering.defs = doc.numbering
    editor.commands.setContent(blocksToPmDoc(doc.blocks, sections) as never)
    if (format === 'md') return documentToMarkdown(editor, { includeImages: false }).markdown
    inlineHeadlessStyles(editor.view.dom)
    const settings = sections[0]?.settings
    const textWidthPx = settings ? (settings.pageWidth - settings.marginLeft - settings.marginRight) / 15 : undefined
    return buildStandaloneHtml(editor.view.dom, {
      title,
      ...(textWidthPx === undefined ? {} : { textWidthPx }),
      contentSecurityPolicy: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    })
  } finally {
    editor?.destroy()
    root.remove()
  }
}
