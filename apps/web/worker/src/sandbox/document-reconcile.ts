import {randomUUID} from 'node:crypto'
import {DocumentContractError} from './document-profiles.ts'
import type {Reservation} from './document-execution-ports.ts'
import type {createTestPostgresDocumentReservations} from './document-reservations-pg.ts'
type Ledger=ReturnType<typeof createTestPostgresDocumentReservations>
export function createDocumentReconciler():never{throw new DocumentContractError('DOCUMENT_RECONCILE_DISABLED')}
/** Test-only trusted ledger composition. Deliberately has NO broker/backend port.
 * A committed no-start decision is safe; every possibly-started instance remains
 * charged. No job authorization is granted and no document content is returned.
 */
export function createTestDocumentReconciler(ledger:Ledger,options:{unsafeTestOnly:true}){
 const gate=()=>{if(process.env.NODE_ENV!=='test'||options.unsafeTestOnly!==true)throw new DocumentContractError('DOCUMENT_RECONCILE_DISABLED')}
 gate()
 return Object.freeze({async reconcile(raw:Reservation){
  gate()
  const reservation=Object.freeze({reservationId:raw.reservationId,jobId:raw.jobId,attempt:raw.attempt,jobEpoch:raw.jobEpoch})
  const claimId=randomUUID()
  try{
   const row=await ledger.inspect(reservation)
   if(row.state==='released')return Object.freeze({reservationId:reservation.reservationId,outcome:'already_released'})
   const claim=await ledger.claimReconcile(reservation,row.version,claimId)
   return await ledger.completeReconcile(claim)
  }catch{
   const error=new DocumentContractError('DOCUMENT_RECONCILE_UNCERTAIN')
   Object.assign(error,{reservationKey:reservation.reservationId,claimId})
   throw error
  }
 }})
}
