import type {PDFDocument} from 'pdf-lib'

export const MAX_PDF_EDIT_PAGES:100
export const MAX_PDF_DRAFT_BLANK_PAGES:20

export function assertPdfEditStructure(doc:PDFDocument,options?:{allowAcroForm?:boolean}):void
export function hasUnsupportedPdfForm(doc:PDFDocument):boolean
