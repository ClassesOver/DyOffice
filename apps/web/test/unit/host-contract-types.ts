import type { Principal, JobRef } from '../../../../packages/web-contracts/src/api.ts'
import type { Problem } from '../../../../packages/web-contracts/src/errors.ts'
import type { CommandEnvelope } from '../../../../packages/web-contracts/src/tools.ts'
const principal: Principal = {userId:'u',sessionId:'s',deploymentId:'d',roles:['user'],scopes:[]}
const job: JobRef = {id:'j'}
const problem: Problem = {type:'about:blank',title:'Conflict',status:409,detail:'Conflict',requestId:'r'}
const command: CommandEnvelope = {commandId:'c',fileId:'f',baseRevision:'r',editorGeneration:0,leaseEpoch:1,argsHash:'a'.repeat(64),payload:{}}
void [principal,job,problem,command]
// @ts-expect-error A server principal must carry roles, not silently omit them.
const missingRoles: Principal = {userId:'u',sessionId:'s',deploymentId:'d',scopes:[]}
// @ts-expect-error A job identity is opaque text, not an incrementable number.
const numericJob: JobRef = {id:1}
// @ts-expect-error Versionless commands cannot be approved by this contract.
const missingVersion: CommandEnvelope = {commandId:'c',fileId:'f',editorGeneration:0,leaseEpoch:1,argsHash:'a'.repeat(64),payload:{}}
// @ts-expect-error HTTP status is numeric, never a transport-coerced string.
const stringStatus: Problem = {type:'about:blank',title:'Error',status:'500',detail:'Error',requestId:'r'}
void [missingRoles,numericJob,missingVersion,stringStatus]
