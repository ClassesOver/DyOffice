import type {Pool} from 'pg'
import {randomBytes,createHash} from 'node:crypto'
import {assertRuntimePool} from '../../db/roles.ts'

export interface BackgroundClaim {taskId:string;conversationId:string;credential:string;claimId:string;expired:boolean;token:string}
export function createAssistantBackgroundStore({pool,deploymentId}:{pool:Pool;deploymentId:string}) {
 let admitted:ReturnType<typeof assertRuntimePool>|undefined
 const hash=(token:string)=>createHash('sha256').update(token).digest('hex')
 return {
  async take():Promise<BackgroundClaim|null>{
   await (admitted??=assertRuntimePool(pool,'worker'))
   const token=randomBytes(32).toString('base64url')
   const result=(await pool.query('SELECT take_assistant_background($1,$2) AS value',[deploymentId,hash(token)])).rows[0].value
   return result?{...result,token}:null
  },
  async abandon(claim:BackgroundClaim){
   return (await pool.query('SELECT abandon_assistant_background($1,$2,$3,$4) AS value',[deploymentId,claim.taskId,claim.claimId,hash(claim.token)])).rows[0].value as boolean
  },
 }
}
export type AssistantBackgroundStore=ReturnType<typeof createAssistantBackgroundStore>
