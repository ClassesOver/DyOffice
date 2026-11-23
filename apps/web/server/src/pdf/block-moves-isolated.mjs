import {parsePdfBlockMovesRequest,pdfBlockMovesSafetyCodes} from './block-moves-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfBlockMovesJob(){return createPdfProcessJob('blockMoves',parsePdfBlockMovesRequest,pdfBlockMovesSafetyCodes)}
