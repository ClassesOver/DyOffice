import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {verifyPdfCandidate} from '../../scripts/prepare-pdf-runtime-candidate.mjs'
import {identity,tuple,commandSnapshot,frameCollector,resultHeader,requestHeader,encodeFrame,sha,MAX_PDF_BYTES} from './pdf-candidate-wire.mjs'
/** Trusted generated PDFs only. This fixture never certifies OS isolation or a
 * runtime grant. Verification-to-exec path race assumes a trusted temp directory.
 */
export async function runGeneratedPdfCandidateFixture(options){
 const gate=()=>{if(process.env.NODE_ENV!=='test'||options.unsafeGeneratedFixtureOnly!==true)throw Error('PDF_FIXTURE_ONLY')};gate()
 if(!Buffer.isBuffer(options.bytes)||options.bytes.length<1||options.bytes.length>MAX_PDF_BYTES)throw Error('PDF_FIXTURE_INPUT')
 const bytes=Buffer.from(options.bytes),command=commandSnapshot(options.command),ids=identity(options.binding)
 const directory=options.directory,contentDigest=options.contentDigest,signal=options.signal,fault=options.fault
 if(fault!==undefined&&!['stall','parent-timeout','wrong-binding','wrong-hash','truncated','trailing','stderr-flood','early-exit'].includes(fault))throw Error('PDF_FIXTURE_PROTOCOL')
 const binding=tuple({requestId:randomUUID(),...ids,inputSha256:sha(bytes),inputSize:bytes.length,commandDigest:command.digest})
 const request=requestHeader({version:1,kind:'pdf-fixture-request',binding,command:command.command})
 if(signal?.aborted)throw Error('PDF_FIXTURE_ABORTED')
 await verifyPdfCandidate(directory,contentDigest);gate()
 if(signal?.aborted)throw Error('PDF_FIXTURE_ABORTED')
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[join(directory,'session.cjs')],{shell:false,env:{NODE_ENV:'test',DYOFFICE_PDF_GENERATED_FIXTURE:'1',...(fault?{DYOFFICE_PDF_FIXTURE_FAULT:fault}:{})},stdio:['pipe','pipe','pipe']})
  const collector=frameCollector(resultHeader,h=>h.outputSize)
  let failure,stderr=0,eof=false,closed=false,settled=false,cleanupTimer
  const finishError=()=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(cleanupTimer);signal?.removeEventListener('abort',abort);reject(Object.assign(Error(failure??'PDF_FIXTURE_FAILED'),{fixtureOnly:true,exitObserved:closed}))}
  const fail=code=>{
   if(!failure)failure=code
   clearTimeout(timer);child.stdin.destroy()
   if(!closed){child.kill('SIGKILL');cleanupTimer??=setTimeout(()=>{failure='PDF_FIXTURE_EXIT_UNCONFIRMED';child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();finishError()},1000)}else finishError()
  }
  const abort=()=>fail('PDF_FIXTURE_ABORTED'),timer=setTimeout(()=>fail('PDF_FIXTURE_TIMEOUT'),8000)
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
  child.on('error',()=>fail('PDF_FIXTURE_PROCESS_ERROR'));child.stdin.on('error',()=>fail('PDF_FIXTURE_PIPE_ERROR'));child.stdout.on('error',()=>fail('PDF_FIXTURE_PIPE_ERROR'));child.stderr.on('error',()=>fail('PDF_FIXTURE_PIPE_ERROR'))
  child.stdout.on('data',chunk=>{if(failure)return;try{collector.push(chunk)}catch{fail('PDF_FIXTURE_OUTPUT_INVALID')}})
  child.stdout.on('end',()=>{eof=true})
  child.stderr.on('data',chunk=>{stderr+=chunk.length;if(stderr>4096)fail('PDF_FIXTURE_LOG_LIMIT')})
  child.once('close',(code,terminationSignal)=>{
   closed=true;clearTimeout(timer);clearTimeout(cleanupTimer);signal?.removeEventListener('abort',abort)
   if(settled)return
   if(failure||code!==0||terminationSignal||!eof||stderr){failure??='PDF_FIXTURE_FAILED';finishError();return}
   try{
    gate();if(signal?.aborted)throw Error()
    const result=collector.finish()
    if(JSON.stringify(result.header.binding)!==JSON.stringify(binding)||sha(result.bytes)!==result.header.outputSha256||result.bytes.length!==result.header.outputSize)throw Error()
    settled=true;resolve(Object.freeze({binding,bytes:result.bytes,sha256:result.header.outputSha256,size:result.header.outputSize,fixtureOnly:true}))
   }catch{failure='PDF_FIXTURE_OUTPUT_INVALID';finishError()}
  })
  try{for(const part of encodeFrame(request,bytes))child.stdin.write(part);child.stdin.end()}catch{fail('PDF_FIXTURE_PIPE_ERROR')}
 })
}
