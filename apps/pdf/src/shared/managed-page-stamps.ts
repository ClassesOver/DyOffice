import { PDFName } from 'pdf-lib'
import type { PDFDocument } from 'pdf-lib'

const stampMetadata = PDFName.of('DyOfficeStamps')

/** Keep the visible stamp streams as page content when combining independently stamped PDFs. */
export function detachPdfStampManagement(doc: PDFDocument): void {
  for (const page of doc.getPages()) page.node.delete(stampMetadata)
}
