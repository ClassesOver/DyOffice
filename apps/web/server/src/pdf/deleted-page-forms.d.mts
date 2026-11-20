import type {PDFDocument} from 'pdf-lib'
/** Must run before page deletion, using original page ref strings from this same document. */
export function cleanupDeletedPageForms(doc:PDFDocument,deletedPageRefs:readonly string[]):void
