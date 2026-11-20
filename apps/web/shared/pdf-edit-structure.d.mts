import type {PDFDocument} from 'pdf-lib'

export function assertPdfEditStructure(doc:PDFDocument,options?:{allowAcroForm?:boolean}):void
export function hasUnsupportedPdfForm(doc:PDFDocument):boolean
