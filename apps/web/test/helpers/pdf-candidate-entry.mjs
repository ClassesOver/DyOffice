// Fixed bundled entry. Only synthetic generated tests, never production input.
import {createPdfRotationJob} from '../../server/src/pdf/rotation-job.mjs'
import {frameCollector,requestHeader,encodeFrame,sha,MAX_PDF_BYTES} from './pdf-candidate-wire.mjs'
if(process.env.NODE_ENV!=='test'||process.env.DYOFFICE_PDF_GENERATED_FIXTURE!=='1'){process.exitCode=78}
else{
 const fault=process.env.DYOFFICE_PDF_FIXTURE_FAULT
 let failed=false,ended=false
 const timer=setTimeout(()=>reject(),fault==='parent-timeout'?15000:5000)
 function reject(){if(failed)return;failed=true;clearTimeout(timer);process.stderr.write('PDF_FIXTURE_FAILED\n');process.exitCode=1;process.stdin.destroy()}
 const collector=frameCollector(requestHeader,h=>h.binding.inputSize)
 process.stdin.on('error',reject)
 process.stdin.on('data',chunk=>{try{collector.push(chunk)}catch{reject()}})
 process.stdin.on('end',async()=>{
  if(failed||ended)return;ended=true
  try{
   if(fault!==undefined&&!['stall','parent-timeout','wrong-binding','wrong-hash','truncated','trailing','stderr-flood','early-exit'].includes(fault))throw Error()
   if(fault==='stall'||fault==='parent-timeout')return
   if(fault==='early-exit'){clearTimeout(timer);process.exitCode=7;return}
   const {header,bytes}=collector.finish();if(sha(bytes)!==header.binding.inputSha256)throw Error()
   const output=await createPdfRotationJob().execute(bytes,JSON.stringify(header.command))
   if(failed||output.bytes.length>MAX_PDF_BYTES||output.size!==output.bytes.length||output.sha256!==sha(output.bytes))throw Error()
   const result={version:1,kind:'pdf-fixture-result',binding:header.binding,outputSha256:output.sha256,outputSize:output.size}
   if(fault==='wrong-binding')result.binding={...result.binding,contextVersion:result.binding.contextVersion+1}
   if(fault==='wrong-hash')result.outputSha256='0'.repeat(64)
   if(fault==='stderr-flood')process.stderr.write('x'.repeat(5000))
   const parts=encodeFrame(result,output.bytes)
   if(fault==='truncated')parts[2]=parts[2].subarray(0,-1)
   for(const part of parts)process.stdout.write(part)
   if(fault==='trailing')process.stdout.write(Buffer.from([0]))
   clearTimeout(timer)
  }catch{reject()}
 })
}
