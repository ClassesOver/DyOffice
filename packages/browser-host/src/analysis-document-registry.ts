import type {AnalysisDocumentTarget} from '../../web-contracts/src/analysis-document.ts'
export function createAnalysisDocumentRegistry(){
 let target:AnalysisDocumentTarget|undefined,disposed=false
 const listeners=new Set<()=>void>()
 const emit=()=>{for(const fn of listeners)try{fn()}catch{}}
 return {
  current:()=>target,
  register(next:AnalysisDocumentTarget){
   if(disposed){next.dispose();return()=>{}}
   if(target!==next)target?.dispose()
   target=next;emit()
   return()=>{if(target===next){target=undefined;next.dispose();emit()}}
  },
  subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn)}},
  dispose(){disposed=true;target?.dispose();target=undefined;emit();listeners.clear()},
 }
}
