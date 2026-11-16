import {performance} from 'node:perf_hooks'
const distribution=values=>{
 if(!values.length)return null
 const sorted=[...values].sort((a,b)=>a-b)
 const rank=p=>sorted[Math.ceil(p*sorted.length)-1]
 return {count:values.length,min:sorted[0],p50:rank(.5),p95:rank(.95),p99:rank(.99),max:sorted.at(-1),mean:values.reduce((a,b)=>a+b,0)/values.length}
}
export function summarize(samples){
 if(!Array.isArray(samples)||!samples.length)throw new Error('Nonempty measurements required')
 for(const s of samples)if(!Number.isFinite(s.durationMs)||s.durationMs<0||typeof s.ok!=='boolean'||!Number.isInteger(s.status)||s.status<0||s.status>599)throw new Error('Invalid measurement')
 const successes=samples.filter(s=>s.ok),statuses={}
 for(const s of samples)statuses[s.status]=(statuses[s.status]||0)+1
 return {attempted:samples.length,succeeded:successes.length,failed:samples.length-successes.length,statuses,all:distribution(samples.map(s=>s.durationMs)),successful:distribution(successes.map(s=>s.durationMs))}
}
export async function runSamples({count,concurrency,request}){
 if(!Number.isInteger(count)||count<1||count>1000||!Number.isInteger(concurrency)||concurrency<1||concurrency>4||typeof request!=='function')throw new Error('Bounded sampling parameters required')
 const result=new Array(count);let next=0
 await Promise.all(Array.from({length:Math.min(count,concurrency)},async()=>{
  for(;;){const i=next++;if(i>=count)return;const start=performance.now();try{result[i]=await request(i)}catch{result[i]={durationMs:performance.now()-start,status:0,ok:false,error:'request-threw'}}}
 }))
 summarize(result);return result
}
export const BASELINE_WORKLOAD=Object.freeze({routeCount:3,firstPerRoute:1,warmupPerRoute:5,rounds:3,samplesPerRouteRound:30,concurrency:Object.freeze([1,4])})
