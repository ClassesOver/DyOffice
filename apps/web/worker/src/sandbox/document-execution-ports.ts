import type {DocumentExecutionRequest} from './document-contract.ts'
import type {ExecutionHandle,ProfileCommand,ResultContext,StopObservation} from './document-control.ts'
/** These ports are TRUSTED control-plane adapters, not document-provided callbacks.
 * None has a production implementation in this change. No PG token crosses backend.
 */
export interface AuthoritySnapshot {request:DocumentExecutionRequest;validUntil:string}
export interface Reservation {reservationId:string;jobId:string;attempt:number;jobEpoch:number}
export interface ReservationGrant {readonly reservationId:string;readonly granted:true}
export interface DocumentExecutionPorts {
 authority:{verify(request:DocumentExecutionRequest,phase:'pre'|'before_start'|'post'|'return',signal:AbortSignal):Promise<AuthoritySnapshot>}
 /** Every call is idempotent/CAS by deterministic reservationId. retain must durably
  * record a reconcile tombstone even if reserve has not returned: late reserve/bind
  * cannot overwrite quarantine or terminal state. A timed-out release is unknown.
  */
 reservations:{
  reserve(reservation:Reservation,request:DocumentExecutionRequest):Promise<ReservationGrant>
  bind(reservation:Reservation,handle:ExecutionHandle):Promise<void>
  retain(reservation:Reservation,reason:string):Promise<void>
  release(reservation:Reservation,evidence:{notStarted:true}|{stop:StopObservation}):Promise<void>
 }
 backend:{
  start(request:DocumentExecutionRequest,input:Uint8Array,signal:AbortSignal):Promise<unknown>
  execute(handle:ExecutionHandle,command:ProfileCommand,context:ResultContext,signal:AbortSignal):Promise<unknown>
  stop(handle:ExecutionHandle):Promise<unknown>
 }
}
