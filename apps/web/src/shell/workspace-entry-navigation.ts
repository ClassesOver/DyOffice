import type {createDocumentTabs,DocumentTab} from './document-tabs'
/** Shared by the actual hashchange effect and regression tests. No document is
 * disposed here. Both route sequence and tab selection fence asynchronous work. */
export function createEntryNavigator({tabs,resolve,allow,onStart,onError,replace,markRouting}:{
 tabs:ReturnType<typeof createDocumentTabs>;resolve:(id:string)=>Promise<DocumentTab>;allow:()=>boolean;
 onStart:()=>void;onError:(error:unknown)=>void;replace:(id:string)=>void;markRouting:(value:boolean)=>void
}){
 let sequence=0,alive=true
 const selected=()=>tabs.list().find(tab=>tab.active)?.id??'home'
 return {
  async navigate(target:string){
   if(!alive)return
   const ticket=++sequence
   // Even refused/newer Home navigation supersedes a pending request.
   if(!allow()){tabs.activate(selected());markRouting(false);replace(selected());return}
   onStart();markRouting(true)
   if(target==='home'||(!tabs.isCitationExpired(target)&&tabs.documents().some(file=>file.id===target&&!(file.format==='docx'&&file.sourceRevision)))){
    tabs.activate(target);markRouting(false);replace(selected());return
   }
   const token=tabs.reserveOpen(target)
   const current=()=>alive&&ticket===sequence&&tabs.isOpenCurrent(token)
   try{const document=await resolve(target);if(current())tabs.open(document,token)}
   catch(error){if(current()){onError(error);tabs.activate('home')}}
   finally{if(alive&&ticket===sequence){markRouting(false);replace(selected())}}
  },
  dispose(){alive=false;sequence++;markRouting(false)},
 }
}
