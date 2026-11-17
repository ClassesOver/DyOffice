import type {RevisionRef} from '../../web-contracts/src/api.ts'
import type {AnalysisDocumentTarget,AnalysisTargetCapture,NativeAnalysisEditor,PreparedAnalysisContent} from '../../web-contracts/src/analysis-document.ts'
export function createAnalysisDocumentTarget(o:{fileId:string;format:'docx'|'xlsx';state:()=>{revision:RevisionRef;lease:{leaseEpoch:number}|null;status:string};editor:()=>NativeAnalysisEditor|null;save:(check:()=>boolean)=>Promise<boolean>;receipt:()=>RevisionRef|null;verifyAuthority:()=>Promise<void>}):AnalysisDocumentTarget {
 let disposed=false,busy=false
 const captures=new Map<AnalysisTargetCapture,{native:ReturnType<NativeAnalysisEditor['captureAnalysis']>}>()
 const applications=new Map<string,{native:ReturnType<NativeAnalysisEditor['captureAnalysis']>;base:string;epoch:number}>()
 const live=()=>{const s=o.state();return !disposed&&s.status==='idle'&&!!s.lease}
 const error=()=>new Error('Document target changed or is unavailable')
 const authority=(c:{base:string;epoch:number})=>{if(!live())return false;const s=o.state();return s.revision.revision===c.base&&s.lease?.leaseEpoch===c.epoch}
 return {fileId:o.fileId,format:o.format,
 capture(){if(busy||!live())throw error();const native=o.editor()?.captureAnalysis();if(!native)throw error();const s=o.state();const c=Object.freeze({token:crypto.randomUUID(),fileId:o.fileId,format:o.format,baseRevision:s.revision.revision,leaseEpoch:s.lease!.leaseEpoch});captures.clear();captures.set(c,{native});return c},
 async apply(c,content:PreparedAnalysisContent,artifact,authorized){
  const held=captures.get(c);captures.delete(c)
  if(!held||busy||!artifact.artifactId||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw error()
  const fence={base:c.baseRevision,epoch:c.leaseEpoch},check=()=>authorized()&&authority(fence)&&held.native.matches()
  if(!check())throw error();busy=true
  try{await o.verifyAuthority();if(!check())throw error();if(!await held.native.apply(content,check)||!authorized()||!authority(fence))throw error()
   const native=o.editor()?.captureAnalysis();if(!native)throw error()
   const applicationId=crypto.randomUUID();applications.clear();applications.set(applicationId,{native,...fence})
   return {status:'applied_uncommitted',applicationId}
  }finally{busy=false}
 },
 async save(applicationId,authorized){
  const app=applications.get(applicationId)
  if(!authorized()||!app||busy||!authority(app))return {status:'not_confirmed',reason:'unavailable'}
  if(!(app.native.matchesForSave?.()??app.native.matches()))return {status:'not_confirmed',reason:'newer_edits'}
  busy=true;const previous=o.receipt()
  const saveCheck=()=>{if(disposed||!authorized())return false;const s=o.state();return (s.status==='idle'||s.status==='saving'||s.status==='unknown')&&s.revision.revision===app.base&&s.lease?.leaseEpoch===app.epoch&&(app.native.matchesForSave?.()??app.native.matches())}
  try{
   await o.verifyAuthority();if(!authorized()||!authority(app)||!(app.native.matchesForSave?.()??app.native.matches()))return {status:'not_confirmed',reason:'conflict'}
   if(!await o.save(saveCheck)||disposed||!authorized())return {status:'not_confirmed',reason:'unknown'}
   const receipt=o.receipt(),s=o.state()
   if(!receipt||receipt===previous||receipt.fileId!==o.fileId||receipt.revision===app.base||s.status!=='idle'||s.lease?.leaseEpoch!==app.epoch||s.revision.revision!==receipt.revision)return {status:'not_confirmed',reason:'unknown'}
   applications.delete(applicationId);return {status:'saved',applicationId,receipt:{...receipt}}
  }catch{return {status:'not_confirmed',reason:'unknown'}}finally{busy=false}
 },
 dispose(){disposed=true;captures.clear();applications.clear()},
 }
}
