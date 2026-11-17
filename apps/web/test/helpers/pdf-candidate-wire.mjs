// Trusted generated-fixture protocol only. Correlation is NOT authorization.
import {createHash} from 'node:crypto'
import {validatePdfRotationOperations} from '../../worker/src/sandbox/pdf-rotation-schema.ts'
export const MAX_PDF_BYTES=32*1024*1024,MAX_HEADER=16*1024
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const shaPattern=/^[a-f0-9]{64}$/
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export function fail(){throw new Error('PDF_FIXTURE_PROTOCOL')}
function exact(value,keys){
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length)fail()
 const out={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!('value'in d)||!d.enumerable)fail();out[k]=d.value}return out
}
export function commandSnapshot(raw){
 const r=exact(raw,['version','action','operations']);if(r.version!==1||r.action!=='rotatePages')fail()
 const command=Object.freeze({version:1,action:'rotatePages',operations:validatePdfRotationOperations(r.operations)}),json=JSON.stringify(command)
 return {command,json,digest:sha(json)}
}
const identityKeys=['contextId','contextVersion','jobId','jobEpoch','attempt','fileId','baseRevision','leaseEpoch']
export function identity(raw){const r=exact(raw,identityKeys);for(const k of ['contextId','jobId','fileId','baseRevision'])if(typeof r[k]!=='string'||!uuid.test(r[k]))fail();for(const k of ['contextVersion','jobEpoch','attempt','leaseEpoch'])if(!Number.isSafeInteger(r[k])||r[k]<1)fail();return Object.freeze(r)}
export function tuple(raw){
 const r=exact(raw,['requestId',...identityKeys,'inputSha256','inputSize','commandDigest'])
 identity(Object.fromEntries(identityKeys.map(k=>[k,r[k]])))
 if(typeof r.requestId!=='string'||!uuid.test(r.requestId)||typeof r.inputSha256!=='string'||!shaPattern.test(r.inputSha256)||typeof r.commandDigest!=='string'||!shaPattern.test(r.commandDigest)||!Number.isSafeInteger(r.inputSize)||r.inputSize<1||r.inputSize>MAX_PDF_BYTES)fail()
 return Object.freeze(r)
}
export function requestHeader(raw){const r=exact(raw,['version','kind','binding','command']);if(r.version!==1||r.kind!=='pdf-fixture-request')fail();const binding=tuple(r.binding),c=commandSnapshot(r.command);if(binding.commandDigest!==c.digest)fail();return Object.freeze({version:1,kind:r.kind,binding,command:c.command})}
export function resultHeader(raw){const r=exact(raw,['version','kind','binding','outputSha256','outputSize']);if(r.version!==1||r.kind!=='pdf-fixture-result'||typeof r.outputSha256!=='string'||!shaPattern.test(r.outputSha256)||!Number.isSafeInteger(r.outputSize)||r.outputSize<1||r.outputSize>MAX_PDF_BYTES)fail();return Object.freeze({...r,binding:tuple(r.binding)})}
export function encodeFrame(header,bytes){const json=Buffer.from(JSON.stringify(header));if(json.length<1||json.length>MAX_HEADER||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_PDF_BYTES)fail();const prefix=Buffer.alloc(4);prefix.writeUInt32BE(json.length);return [prefix,json,bytes]}
// Bound lengths BEFORE concatenation; only one header/body and exact EOF accepted.
export function frameCollector(validate,sizeOf){
 let prefix=Buffer.alloc(4),prefixLength=0,headerLength=0,headerBytes,headerOffset=0,header,body,bodyLength=0,ended=false
 return {push(chunk){
  if(ended||!Buffer.isBuffer(chunk))fail();let offset=0
  while(offset<chunk.length){
   if(prefixLength<4){const n=Math.min(4-prefixLength,chunk.length-offset);chunk.copy(prefix,prefixLength,offset,offset+n);prefixLength+=n;offset+=n;if(prefixLength===4){headerLength=prefix.readUInt32BE();if(headerLength<1||headerLength>MAX_HEADER)fail();headerBytes=Buffer.alloc(headerLength)}continue}
   if(headerOffset<headerLength){const n=Math.min(headerLength-headerOffset,chunk.length-offset);chunk.copy(headerBytes,headerOffset,offset,offset+n);headerOffset+=n;offset+=n;if(headerOffset===headerLength){const text=new TextDecoder('utf8',{fatal:true}).decode(headerBytes);header=validate(JSON.parse(text));if(JSON.stringify(header)!==text)fail();const size=sizeOf(header);if(!Number.isSafeInteger(size)||size<1||size>MAX_PDF_BYTES)fail();body=Buffer.alloc(size)}continue}
   const n=chunk.length-offset;if(!header||bodyLength+n>sizeOf(header)||bodyLength+n>MAX_PDF_BYTES)fail();chunk.copy(body,bodyLength,offset);bodyLength+=n;offset=chunk.length
  }
 },finish(){if(ended||!header||bodyLength!==sizeOf(header))fail();ended=true;return {header,bytes:body}}}
}
