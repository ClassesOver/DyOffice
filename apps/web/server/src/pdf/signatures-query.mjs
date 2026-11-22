import {createPdfProcessJob} from './pdf-process-job.mjs'
import {fail,hash,requireEnvelope} from './job-common.mjs'

export const pdfSignatureSafetyCodes=new Set(['OUTPUT_LIMIT'])

function parseRequest(raw){
 const request=JSON.parse(raw)
 requireEnvelope(request,'signaturesQuery','operations')
 if(!Array.isArray(request.operations)||request.operations.length!==0)fail('INVALID_REQUEST')
 return []
}

export function createIsolatedPdfSignaturesQueryJob(){
 return createPdfProcessJob('signaturesQuery',parseRequest,pdfSignatureSafetyCodes)
}

export function createPdfSignaturesQueryJob(){
 return {async execute(input,raw){
  parseRequest(raw)
  const {readPdfSignatures}=await import('../../../../pdf/src/main/pdf-signatures.ts')
  const signatures=await readPdfSignatures(input)
  const bytes=Buffer.from(JSON.stringify(signatures))
  if(bytes.length>1024*1024)fail('OUTPUT_LIMIT')
  return {bytes,size:bytes.length,inputSha256:hash(input),sha256:hash(bytes)}
 }}
}
