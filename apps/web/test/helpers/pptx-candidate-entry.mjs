// Test entry only. Reuses the existing IPC dispatcher, NOT a restricted broker.
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {verifyPptxCandidate} from '../../scripts/prepare-pptx-runtime-candidate.mjs'
if(process.env.NODE_ENV!=='test'||process.env.DYOFFICE_GENERATED_PPTX_FIXTURE!=='1'||typeof process.send!=='function'||process.argv.length!==4){
 process.exitCode=78
 if(process.connected)process.disconnect()
}else{
 try{
  await verifyPptxCandidate(process.argv[2],process.argv[3])
  const candidate=createRequire(import.meta.url)(join(process.argv[2],'session.cjs'))
  if(typeof candidate.runPptxSessionChild!=='function')throw new Error('FIXTURE_ENTRY_MISSING')
  candidate.runPptxSessionChild()
 }catch{
  process.exitCode=78
  if(process.connected)process.disconnect()
 }
}
