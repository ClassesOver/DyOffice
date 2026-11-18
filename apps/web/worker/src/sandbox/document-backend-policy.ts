import {DocumentContractError} from './document-profiles.ts'
/** Deployment selection only, never runtime approval. An absent selector preserves
 * existing explicit experimental flags. Selecting legacy does not enable them. */
export function assertDocumentBackendPolicy(environment:NodeJS.ProcessEnv):void {
 const backend=environment.DYOFFICE_DOCUMENT_BACKEND
 if(backend===undefined||backend==='legacy-experimental')return
 if(backend==='broker-required'){
  // Production broker admission is not implemented. Do not probe a test binary,
  // accept operator metadata as a grant, open dependencies or fall back to legacy.
  throw new DocumentContractError('DOCUMENT_BROKER_UNAVAILABLE')
 }
 throw new DocumentContractError('DOCUMENT_BACKEND_INVALID')
}
