import type {PreparedAnalysisContent} from '../../../../packages/web-contracts/src/analysis-document'
import {literalRows} from '../../../../packages/browser-host/src/analysis-literal-content'
import {fitInside, literalImage} from '../../../../packages/browser-host/src/analysis-image'

/** 使用原生事务写入字面值，不把交付内容解释成 HTML、公式或脚本。 */
export function analysisSlideOperations(content:PreparedAnalysisContent,index:number,width:number,height:number):unknown[]{
 if(!Number.isInteger(index)||index<0||!Number.isFinite(width)||!Number.isFinite(height)||width<100||height<100)throw new Error('Invalid slide target')
 const offset={x:Math.round(width*.05*9525),y:Math.round(height*.1*9525),cx:Math.round(width*.9*9525),cy:Math.round(height*.8*9525)}
 if(content.kind==='image'){
  // Native picture from validated bytes, aspect ratio kept and centred in the free area.
  const image=literalImage(content),hasProvenance=!!image.provenance?.length
  // Same cap as the native media insertion path.
  if(image.base64.length*3/4>5*1024*1024)throw new Error('Image exceeds the 5 MiB slide picture limit')
  const boxWidth=width*.9,boxHeight=height*(hasProvenance?.6:.8)
  const size=fitInside(image.width,image.height,boxWidth,boxHeight,true)
  const picture={op:'addPicture',target:{slide:index},bytes:`data:${image.mediaType};base64,${image.base64}`,ext:image.mediaType==='image/png'?'png':'jpg',
   ...(image.alt?{descr:image.alt}:{}),
   offset:{x:Math.round((width*.05+(boxWidth-size.width)/2)*9525),y:Math.round((height*.1+(boxHeight-size.height)/2)*9525),cx:Math.round(size.width*9525),cy:Math.round(size.height*9525)}}
  if(!hasProvenance)return [picture]
  const notes=literalRows({kind:'text',text:image.provenance!.join('\n')})
  return [picture,{op:'addElement',target:{slide:index},kind:'textbox',offset:{...offset,y:Math.round(height*.72*9525),cy:Math.round(height*.18*9525)},bodyPr:{autoFit:'shrink'},paragraphs:notes.map(([text])=>({runs:[{text}]}))}]
 }
 const rows=literalRows(content)
 if(content.kind==='table'){
  // 原生表格只支持最多75行；过大的表格不能通过截断冒充完整交付。
  if(rows.length>75)throw new Error('Table exceeds the native slide table limit (75 rows)')
  const hasProvenance=!!content.provenance?.length
  const tableHeight=hasProvenance?.6:.8
  const cellWidth=width*.9/rows[0]!.length-20,cellHeight=height*tableHeight/rows.length-10
  if(cellWidth<24||cellHeight<28||rows.some(row=>row.some(value=>value.split(/\r\n|\r|\n/).reduce((lines,line)=>lines+Math.max(1,Math.ceil(line.length*24/cellWidth)),0)*28>cellHeight)))throw new Error('Table content does not fit on the current slide; split the delivery into smaller tables')
  const table={op:'addTable',target:{slide:index},offset:{...offset,cy:Math.round(height*tableHeight*9525)},rows:rows.length,cols:rows[0]!.length,cells:rows}
  if(!hasProvenance)return [table]
  const notes=literalRows({kind:'text',text:content.provenance!.join('\n')})
  return [table,{op:'addElement',target:{slide:index},kind:'textbox',offset:{...offset,y:Math.round(height*.72*9525),cy:Math.round(height*.18*9525)},bodyPr:{autoFit:'shrink'},paragraphs:notes.map(([text])=>({runs:[{text}]}))}]
 }
 return [{op:'addElement',target:{slide:index},kind:'textbox',offset,bodyPr:{autoFit:'shrink'},paragraphs:rows.map(row=>({runs:[{text:row[0]}]}))}]
}
type SlideCaptureState={identity:object;slideId:string;index:number;selection:string;generation:number;width:number;height:number}
export function captureSlideAnalysis(o:{current:(forSave?:boolean)=>SlideCaptureState|null;hold:()=>void;run:(ops:unknown[],check:()=>boolean)=>Promise<boolean>}){
 const value=o.current();if(!value)throw new Error('Slide editor unavailable')
 const initial={...value}
 const matches=()=>{const now=o.current();return !!now&&(Object.keys(initial) as (keyof SlideCaptureState)[]).every(key=>now[key]===initial[key])}
 const matchesForSave=()=>{const now=o.current(true);return !!now&&(Object.keys(initial) as (keyof SlideCaptureState)[]).every(key=>now[key]===initial[key])}
 return {matches,matchesForSave,async apply(content:PreparedAnalysisContent,authorized:()=>boolean){
  const ops=analysisSlideOperations(content,initial.index,initial.width,initial.height)
  if(!authorized()||!matches())return false
  o.hold()
  return o.run(ops,()=>authorized()&&matches())
 }}
}
