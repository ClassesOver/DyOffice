// Copied into the disposable DSH workspace and executed by its native shell.
import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'

const {baseURL,memberToken,taskId,marker,resultId}=JSON.parse(await readFile('delegate-input.json','utf8'))
const hash=value=>createHash('sha256').update(value).digest('hex')
async function request(stage,url,token,body){
 const response=await fetch(url,{headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})})
 if(!response.ok)throw Error(stage+' HTTP '+response.status)
 return response.json()
}
const {conversationId,member}=await request('member',baseURL+'/member',memberToken)
const memberURL=baseURL+'/members/'+member.membershipId
const connectionId=randomUUID()
const {connectionEpoch}=await request('connect',memberURL+'/connect',memberToken,{connectionId})
const claim=await request('claim',memberURL+'/claim',memberToken,{taskId,connectionId,connectionEpoch,requestId:randomUUID()})
if(claim.state!=='running'||claim.taskId!==taskId||!claim.claimId)throw Error('Unexpected claim')
const claimRef={claimId:claim.claimId,connectionEpoch:claim.connectionEpoch}
const grant=await request('grant',memberURL+'/tasks/'+taskId+'/data-grant',memberToken,claimRef)
if(grant.baseUrl!==new URL('/api/v1/agents',baseURL).href||grant.grant.inputs.sourceIds.length||grant.grant.inputs.resultIds.length!==1||grant.grant.inputs.resultIds[0]!==resultId)throw Error('Unexpected data scope')
const endpoint=grant.baseUrl+'/tasks/'+grant.grant.taskId+'/data',token=grant.grant.credential
const execute=(operation,args)=>request(operation,endpoint+'/execute',token,{operation,arguments:args})
const {artifact}=await execute('results.get_manifest',{resultId})
const snapshot=await request('snapshot',endpoint+'/results/'+resultId+'/content',token)
const {sha256,...evidence}=snapshot
if(snapshot.truncated||sha256!==artifact.sha256||hash(JSON.stringify(evidence))!==sha256)throw Error('Unverified snapshot')
const total=snapshot.rows.reduce((sum,row)=>sum+row.amount,0)
const summary=marker+' Total '+total+' CNY',bytes=Buffer.from(summary)
const staged=await execute('artifacts.stage',{name:'dsh-budget-report.txt',mediaType:'text/plain',role:'report',inputResultIds:[resultId],sha256:hash(bytes),bytesBase64:bytes.toString('base64')})
const inputs=[Object.fromEntries(['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'].map(key=>[key,artifact[key]]))]
const commandId=randomUUID()
await execute('artifacts.commit',{commandId,summary,artifactIds:[staged.artifactId],inputs,runtimeManifestSha256:hash(await readFile(new URL(import.meta.url))),limitations:['Synthetic frozen rows; deterministic Node test script executed by official DSH.']})
await request('result',memberURL+'/actions',memberToken,{requestId:randomUUID(),conversationId,to:'office',action:{kind:'result',taskId,...claimRef,summary,outcome:'succeeded'}})
await writeFile('delivery-receipt.json',JSON.stringify({commandId,artifactId:staged.artifactId,sha256:hash(bytes),summary}),{mode:0o600})
