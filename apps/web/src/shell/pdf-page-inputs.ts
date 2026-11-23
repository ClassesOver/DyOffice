/** Same portrait paper sizes and range syntax as the desktop PDF editor. */
export const PDF_PAPER_SIZES=[
 {label:'A3',width:842,height:1191},
 {label:'A4',width:595,height:842},
 {label:'A5',width:420,height:595},
 {label:'Letter',width:612,height:792},
 {label:'Legal',width:612,height:1008},
] as const

export function parsePdfPageRanges(value:unknown,pageCount:number):readonly number[]|null{
 if(typeof value!=='string'||!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>100)return null
 if(value.trim().toLowerCase()==='all')return Array.from({length:pageCount},(_,i)=>i+1)
 const result=new Set<number>()
 for(const part of value.split(/[,，]/)){
  const text=part.trim();if(!text)continue
  const match=/^(\d+)\s*[-–]\s*(\d+)$|^(\d+)$/.exec(text)
  if(!match)return null
  const start=Number(match[1]??match[3]),end=Number(match[2]??match[3])
  if(start<1||end>pageCount||start>end)return null
  for(let page=start;page<=end;page++)result.add(page)
 }
 return result.size?[...result].sort((a,b)=>a-b):null
}
