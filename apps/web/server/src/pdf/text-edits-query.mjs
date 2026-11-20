import {createHash} from 'node:crypto'
import {validateTextEdits} from '../../../../pdf/src/main/text-edit.ts'
import {validateNativeTextEdits} from './apply-snapshot.mjs'
import {openPdfForPendingEdits} from './pending-document.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'

const limit=256*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(Error(code),{code})}
export const textEditsQuerySafetyCodes=new Set([
 'INVALID_PDF_APPLY_SNAPSHOT','MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT',
 'SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_STAMP_INTEGRITY_FAILED',
])
function parse(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>limit)fail('INVALID_PDF_APPLY_SNAPSHOT')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_PDF_APPLY_SNAPSHOT')}
 if(command?.version!==1||command.action!=='textEditsQuery'||Object.keys(command).length!==3)fail('INVALID_PDF_APPLY_SNAPSHOT')
 const edits=validateNativeTextEdits(command.operations)
 if(!edits.length)fail('INVALID_PDF_APPLY_SNAPSHOT')
 return edits
}
export function createIsolatedPdfTextEditsQueryJob(){
 return createPdfProcessJob('textEditsQuery',parse,textEditsQuerySafetyCodes)
}
export function createPdfTextEditsQueryJob(){
 return {async execute(input,raw,signal){
  signal?.throwIfAborted()
  if(!Buffer.isBuffer(input)||!input.length||input.length>64*1024*1024)fail('INPUT_LIMIT')
  const edits=parse(raw)
  await openPdfForPendingEdits(input)
  signal?.throwIfAborted()
  const report=await validateTextEdits(input,edits)
  signal?.throwIfAborted()
  const bytes=Buffer.from(JSON.stringify(report))
  if(bytes.length>limit)fail('OUTPUT_LIMIT')
  return {bytes,inputSha256:hash(input),sha256:hash(bytes),size:bytes.length}
 }}
}
