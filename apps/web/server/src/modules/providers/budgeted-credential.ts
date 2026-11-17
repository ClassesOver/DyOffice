import {createScopedAdminCredentialConsumer} from './credential-consumer.ts'
import type {createProviderBudgetService} from './budget.ts'
/** Explicit server-only composition. Neither dependency is an HTTP input. */
export function createBudgetedAdminCredentialConsumer(
  options:Omit<Parameters<typeof createScopedAdminCredentialConsumer>[0],'takeForDispatch'> &
  {budget:ReturnType<typeof createProviderBudgetService>},
) {
  const {budget,...consumer}=options
  return createScopedAdminCredentialConsumer({...consumer,takeForDispatch:async(token,request)=>{
    const {turnId,entryId,configRevision,requestDigest}=request
    const record=await budget.takeForDispatch(token,{turnId,entryId,configRevision,requestDigest},request.claimId)
    if(record.id!==request.reservationId||record.claimId!==request.claimId||record.state!=='unknown')throw Error('Provider credential unavailable')
    return {...request,deploymentId:record.deploymentId,userId:record.userId,sessionId:record.sessionId}
  }})
}
