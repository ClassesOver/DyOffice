import {fail} from './job-common.mjs'
const revisionPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Private in-memory save attempt. No HTTP registration, persistence or sandbox.
 * Exactly one preparation; uncertain commit retries reuse the same T06 payload.
 * Every commit call, even after a known receipt, re-enters T06 authentication.
 * No cleanup after dispatch: an error cannot establish whether commit happened.
 * Process restart recovery requires trusted durable storage, not supplied here.
 */
export function createPdfSaveAttempt({preparation,revisions},input){
  const captured=Object.freeze({...input})
  let state='new',ticket,knownRevision
  return {
    get status(){return state},
    async prepare(options){
      if(state!=='new')fail('PDF_SAVE_STATE')
      state='preparing'
      try{
        const value=await preparation.prepare(captured,options)
        ticket=Object.freeze({commitInput:Object.freeze({...value.commitInput}),sha256:value.sha256,size:value.size})
        state='prepared'
      }catch(error){state='failed';throw error}
    },
    async commit(){
      if(!['prepared','unknown','saved'].includes(state))fail('PDF_SAVE_STATE')
      const prior=state
      state='committing'
      try{
        const value=await revisions.commitRevision(captured.token,ticket.commitInput)
        if(!value||value.fileId!==ticket.commitInput.fileId||typeof value.revision!=='string'||!revisionPattern.test(value.revision)
          ||value.sha256!==ticket.sha256||value.size!==ticket.size
          ||(knownRevision!==undefined&&value.revision!==knownRevision))fail('PDF_RECEIPT_MISMATCH')
        const receipt=Object.freeze({fileId:value.fileId,revision:value.revision,sha256:value.sha256,size:value.size})
        state='saved'
        knownRevision=receipt.revision
        return receipt
      }catch{
        state=prior==='saved'?'saved':'unknown'
        fail(prior==='saved'?'PDF_COMMIT_RECHECK_FAILED':'PDF_COMMIT_UNKNOWN')
      }
    },
  }
}
