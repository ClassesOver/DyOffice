import {SandboxError} from '../sandbox/contracts.ts'
import {createNativeAdmission,type NativeProcess} from './admission.ts'
import type {XlsxMutationPlan} from './xlsx.ts'

const MAX=32*1024*1024,REQUEST_MAX=4*1024*1024
type WirePlan={replaced:[string,string][];added:[string,string][];addedBinary:[string,string][];removedEntries:string[]}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const entry=(name:unknown):name is string=>typeof name==='string'&&name.length>0&&name.length<=1024&&!/[\\:\u0000-\u001f\u007f]/.test(name)&&!name.split('/').some(p=>p===''||p==='.'||p==='..')
const invalid=()=>new SandboxError('INVALID_OUTPUT')
/** Shared wire validation, also bundled into the isolated gateway runner. */
export function decodeGatewayPlan(value:unknown):XlsxMutationPlan {
  if(!record(value)||Object.keys(value).sort().join(',')!=='added,addedBinary,removedEntries,replaced')throw invalid()
  const groups=[value.replaced,value.added,value.addedBinary],removed=value.removedEntries
  if(groups.some(g=>!Array.isArray(g))||!Array.isArray(removed))throw invalid()
  const arrays=groups as unknown[][]
  if(arrays.reduce((n,a)=>n+a.length,removed.length)>256)throw invalid()
  let size=0;const names=new Set<string>()
  const name=(v:unknown)=>{if(!entry(v)||names.has(v))throw invalid();names.add(v);return v}
  const text=(rows:unknown[])=>new Map(rows.map(row=>{
    if(!Array.isArray(row)||row.length!==2||typeof row[1]!=='string')throw invalid()
    size+=Buffer.byteLength(row[1]);if(size>MAX)throw invalid()
    return [name(row[0]),row[1]] as const
  }))
  const replaced=text(arrays[0]),added=text(arrays[1])
  const addedBinary=new Map(arrays[2].map(row=>{
    if(!Array.isArray(row)||row.length!==2||typeof row[1]!=='string'||row[1].length>Math.ceil(MAX/3)*4||row[1].length%4!==0)throw invalid()
    const bytes=Buffer.from(row[1],'base64');if(bytes.toString('base64')!==row[1])throw invalid()
    size+=bytes.byteLength;if(size>MAX)throw invalid()
    return [name(row[0]),bytes] as const
  }))
  return {replaced,added,addedBinary,removedEntries:removed.map(name)}
}
export function encodeGatewayPlan(plan:XlsxMutationPlan):WirePlan {
  const wire:WirePlan={replaced:[...plan.replaced],added:[...plan.added],addedBinary:[...plan.addedBinary].map(([name,bytes])=>[name,Buffer.from(bytes).toString('base64')]),removedEntries:[...plan.removedEntries]}
  decodeGatewayPlan(wire)
  return wire
}
export function createGatewayAdapter(process:NativeProcess) {
  const native=createNativeAdmission(process)
  async function run(bytes:Buffer,command:'gateway_package'|'gateway_plan',request:unknown,signal?:AbortSignal):Promise<unknown> {
    if(signal?.aborted)throw new SandboxError('ABORTED')
    if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX)throw new SandboxError('INPUT_LIMIT')
    let encoded:Buffer
    try{encoded=Buffer.from(JSON.stringify(request))}catch{throw new SandboxError('INPUT_LIMIT')}
    if(encoded.length>REQUEST_MAX)throw new SandboxError('INPUT_LIMIT')
    const invalidInput=Symbol('invalid input')
    const result=await native.run(bytes,async io=>{
      const check=()=>{if(signal?.aborted)throw new SandboxError('ABORTED')}
      check();const path=await io.writePart(encoded);check()
      if(!/^\/work\/part-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path))throw new SandboxError('INVALID_PROTOCOL')
      const reply=await io.request(command,{path});check()
      if(record(reply)&&Object.keys(reply).join(',')==='error'&&reply.error==='INVALID_INPUT')return invalidInput
      if(!record(reply)||Object.keys(reply).join(',')!=='written'||reply.written!==true)throw new SandboxError('INVALID_PROTOCOL')
      const output=await io.readOutput();check()
      if(output.length>MAX)throw new SandboxError('OUTPUT_LIMIT')
      let value:unknown;try{value=JSON.parse(output.toString('utf8'))}catch{throw invalid()}
      if(command==='gateway_plan')return decodeGatewayPlan(value)
      if(!record(value)||Object.keys(value).sort().join(',')!=='connections,queries,redactions,slicers')throw invalid()
      return value
    },{signal})
    // Preserve the host's strict error boundary: application errors must be
    // raised only after successful process termination and cleanup.
    if(result===invalidInput)throw Object.assign(new Error('Invalid workbook input'),{statusCode:400})
    return result
  }
  return {
    planWorkbookSave:(bytes:Buffer,sheets:readonly {id:string;name:string}[],request:unknown,signal?:AbortSignal)=>run(bytes,'gateway_plan',{sheets:sheets.map(({id,name})=>({id,name})),request},signal) as Promise<XlsxMutationPlan>,
    planFromWorkbook:(bytes:Buffer,request:unknown,signal?:AbortSignal)=>run(bytes,'gateway_plan',{request},signal) as Promise<XlsxMutationPlan>,
    readWorkbookPackage:(bytes:Buffer,signal?:AbortSignal)=>run(bytes,'gateway_package',{},signal),
  }
}
