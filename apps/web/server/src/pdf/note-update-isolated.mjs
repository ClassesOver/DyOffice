import {parsePdfNoteUpdateRequest,pdfNoteUpdateSafetyCodes} from './note-update-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'

export function createIsolatedPdfNoteUpdateJob(){
 return createPdfProcessJob('updateNotes',parsePdfNoteUpdateRequest,pdfNoteUpdateSafetyCodes)
}
