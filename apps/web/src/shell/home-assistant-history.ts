export type HomeMessage={role:'user'|'assistant';text:string}
// Keep headroom under both the 1MiB inbound envelope and provider conversion.
export const HOME_REQUEST_BYTES=512*1024
const encoder=new TextEncoder()
export function prepareHomeHistory(previous:HomeMessage[],text:string,measure:(messages:HomeMessage[])=>number,limit=HOME_REQUEST_BYTES){
 if(encoder.encode(text).length>32*1024)throw Error('消息过长，请缩短后再发送。')
 const latest:HomeMessage={role:'user',text}
 if(measure([latest])>limit)throw Error('消息过长，请缩短后再发送。')
 // A failed user-only attempt is its own group, not half of the next turn.
 const groups:HomeMessage[][]=[]
 for(const row of previous){
  if(row.role==='user')groups.push([row])
  else if(groups.length&&row.text)groups[groups.length-1]!.push(row)
 }
 let history=groups.flat(),truncated=history.length!==previous.length
 while(history.length>20||history.some(row=>encoder.encode(row.text).length>256*1024)||measure([...history,latest])>limit){
  groups.shift();history=groups.flat();truncated=true
 }
 return {messages:[...history,latest],truncated}
}
