import type {PDFDocument} from '../../../../pdf/src/shared/pdf-lib.ts'
/** Run before deleting pages or individual widgets, using refs from the current PDFDocument. */
export function cleanupDeletedPageForms(doc:PDFDocument,deletedPageRefs:readonly string[],removedWidgetRefs?:readonly string[]):void
