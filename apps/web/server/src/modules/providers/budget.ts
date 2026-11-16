import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import type {PrincipalTransactions} from '../../db/context.ts'
import {tokenHash} from '../auth/sessions.ts'
export interface BudgetBinding {turnId:string;entryId:string;configRevision:number;requestDigest:string}
export interface BudgetRecord extends BudgetBinding {id:string;claimId:string|null;deploymentId:string;userId:string;sessionId:string;amount:number;state:'reserved'|'dispatching'|'unknown'|'settled'|'cancelled'}
const denied=()=>Object.assign(new Error('Provider budget unavailable'),{statusCode:403})
/** No network/secret access. Each method is a separate durable transaction. */
export function createProviderBudgetService({transactions}:{transactions:PrincipalTransactions}) {
 async function action(token:string,binding:BudgetBinding,op:string,claimId?:string):Promise<Readonly<BudgetRecord>> {
  try {
   if(!binding||Object.keys(binding).some(k=>!['turnId','entryId','configRevision','requestDigest'].includes(k))||typeof binding.turnId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(binding.turnId)||typeof binding.entryId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(binding.entryId)||!Number.isSafeInteger(binding.configRevision)||binding.configRevision<0||typeof binding.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(binding.requestDigest))throw denied()
   const b=Object.freeze({...binding})
   if(claimId!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(claimId))throw denied()
   return await transactions.withPrincipalTransaction({kind:'session',token},async(c,p)=>{
    if(!p.roles.includes('config_admin'))throw denied()
    await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(token),String(transactions.sessionIdleMs)])
    const result=(await c.query('SELECT provider_budget_action($1,$2,$3,$4,$5,$6) AS record',[op,b.turnId,b.entryId,b.configRevision,b.requestDigest,claimId??null])).rows[0]?.record
    if(!result||result.deploymentId!==p.deploymentId||result.userId!==p.userId||result.sessionId!==p.sessionId)throw denied()
    return Object.freeze(result as BudgetRecord)
   })
  }catch{throw denied()}
 }
 return {
  reserve:(token:string,b:BudgetBinding)=>action(token,b,'reserve'),
  claim:(token:string,b:BudgetBinding)=>action(token,b,'claim',randomUUID()),
  takeForDispatch:(token:string,b:BudgetBinding,claim:string)=>action(token,b,'dispatch',claim),
  verifyClaim:(token:string,b:BudgetBinding,claim:string)=>action(token,b,'verify',claim),
  markUnknown:(token:string,b:BudgetBinding,claim:string)=>action(token,b,'unknown',claim),
  settle:(token:string,b:BudgetBinding,claim:string)=>action(token,b,'settle',claim),
  cancel:(token:string,b:BudgetBinding)=>action(token,b,'cancel'),
  status:(token:string,b:BudgetBinding)=>action(token,b,'status'),
 }
}
/** Migration owner only. Existing roles.ts remains unchanged; no ledger DML or secret grants. */
export async function grantProviderBudgetRuntime(pool:Pick<Pool,'query'>,role:string) {
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(role))throw new Error('Invalid runtime role')
 await pool.query(`GRANT EXECUTE ON FUNCTION provider_budget_action(text,text,text,integer,text,uuid) TO "${role}"`)
}
