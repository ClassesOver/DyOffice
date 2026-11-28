const workspaceWindowKey='dyoffice:workspace-window'
const returnWindowKey='dyoffice:return-window'
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const isId=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value)

export type WindowReturnAction={type:'ready'}|{type:'open';fileId:string;pinned:boolean}

export function workspaceWindowId(storage:Storage|undefined){
 if(!storage||typeof BroadcastChannel!=='function')return
 try{
  const saved=storage.getItem(workspaceWindowKey)
  if(isId(saved))return saved
  const id=crypto.randomUUID()
  storage.setItem(workspaceWindowKey,id)
  return id
 }catch{return}
}

export function setWindowReturnTarget(popup:Window,id:string){
 try{
  popup.sessionStorage.removeItem(workspaceWindowKey)
  popup.sessionStorage.setItem(returnWindowKey,id)
 }catch{/* The standalone window can still be used without a return target. */}
}

export function windowReturnTarget(storage:Storage|undefined){
 try{
  const id=storage?.getItem(returnWindowKey)
  if(isId(id))return id
 }catch{return}
}

const channelName=(account:string,id:string)=>`dyoffice:window:${account}:${id}`
function validAction(value:unknown):value is WindowReturnAction{
 if(!value||typeof value!=='object')return false
 const action=value as Partial<Extract<WindowReturnAction,{type:'open'}>>|{type?:'ready'}
 return action.type==='ready'||(action.type==='open'&&isId(action.fileId)&&typeof action.pinned==='boolean')
}

export function listenForWindowReturn(account:string,id:string,handle:(action:WindowReturnAction)=>Promise<boolean>){
 const channel=new BroadcastChannel(channelName(account,id))
 let live=true
 channel.onmessage=async({data})=>{
  if(!live||!isId(data?.requestId)||!validAction(data?.action))return
  let accepted=false
  try{accepted=await handle(data.action)}catch{/* The sending window retains or reopens the document. */}
  if(live)channel.postMessage({requestId:data.requestId,accepted})
 }
 return()=>{live=false;channel.close()}
}

export function requestWindowReturn(account:string,id:string,action:WindowReturnAction){
 return new Promise<boolean>((resolve,reject)=>{
  const channel=new BroadcastChannel(channelName(account,id))
  const requestId=crypto.randomUUID()
  const timeout=setTimeout(()=>finish(false),action.type==='ready'?2500:15000)
  function cleanup(){clearTimeout(timeout);channel.close()}
  function finish(accepted:boolean){cleanup();resolve(accepted)}
  channel.onmessage=({data})=>{
   if(data?.requestId===requestId&&typeof data.accepted==='boolean')finish(data.accepted)
  }
  try{channel.postMessage({requestId,action})}catch(error){cleanup();reject(error)}
 })
}
