import {useRef} from 'react'
import {createPortal} from 'react-dom'
import type {PdfImageDraftInfo} from './pdf-image-drafts'
import type {PreviewPage} from '../shell/pdf-preview-skill'

/** Native draft raster supplies the pixels; this layer handles selection and geometry. */
export function PdfImageDraftOverlay({host,pages,blocks,selected,disabled,onSelect,onTransform,onDelete}:{host:HTMLElement|null;pages:readonly PreviewPage[];blocks:readonly PdfImageDraftInfo[];selected:string;disabled:boolean;onSelect:(id:string)=>void;onTransform:(id:string,geometry:{x?:number;y?:number;width?:number;height?:number})=>void;onDelete:(id:string)=>void}){
 const drag=useRef<{id:string;x:number;y:number;sx:number;sy:number;node:SVGGElement;resize:boolean}|null>(null)
 return <>{pages.map(page=>{
  const surface=host?.querySelector<HTMLElement>(`figure[data-pdf-page="${page.page}"] .pdf-page-surface`),items=blocks.filter(block=>block.page===page.page)
  if(!surface||!items.length||!page.width||!page.height)return null
  return createPortal(<svg aria-label="待保存图片覆盖层" viewBox={`0 0 ${page.width} ${page.height}`} style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',overflow:'visible',zIndex:2}}>{items.map(block=><g key={block.id} role="button" tabIndex={disabled?-1:0} aria-label={`待保存图片 ${block.id}`} aria-pressed={selected===block.id} style={{pointerEvents:disabled?'none':'auto',cursor:'move',touchAction:'none',outline:'none'}}
   onFocus={()=>onSelect(block.id)} onClick={()=>onSelect(block.id)}
   onKeyDown={event=>{if(disabled)return;const steps:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(steps[event.key]){event.preventDefault();const [x,y]=steps[event.key],amount=event.shiftKey?10:1;onTransform(block.id,{x:block.x+x*amount,y:block.y+y*amount})}else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();onDelete(block.id)}}}
   onPointerDown={event=>{if(disabled||event.button!==0)return;event.preventDefault();event.currentTarget.focus();onSelect(block.id);const box=event.currentTarget.ownerSVGElement!.getBoundingClientRect();if(!box.width||!box.height)return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:block.id,x:event.clientX,y:event.clientY,sx:page.width!/box.width,sy:page.height!/box.height,node:event.currentTarget,resize:(event.target as Element).getAttribute('data-resize')==='true'}}}
   onPointerMove={event=>{const current=drag.current;if(current?.id!==block.id)return;const dx=(event.clientX-current.x)*current.sx,dy=(event.clientY-current.y)*current.sy;if(current.resize){current.node.querySelector('rect')!.setAttribute('width',String(Math.max(1,block.width+dx)));current.node.querySelector('rect')!.setAttribute('height',String(Math.max(1,block.height+dy)))}else current.node.setAttribute('transform',`translate(${dx} ${dy})`)}}
   onPointerCancel={event=>{const current=drag.current;if(current?.id!==block.id)return;current.node.removeAttribute('transform');current.node.querySelector('rect')!.setAttribute('width',String(block.width));current.node.querySelector('rect')!.setAttribute('height',String(block.height));if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);drag.current=null}}
   onPointerUp={event=>{const current=drag.current;if(current?.id!==block.id)return;drag.current=null;current.node.removeAttribute('transform');current.node.querySelector('rect')!.setAttribute('width',String(block.width));current.node.querySelector('rect')!.setAttribute('height',String(block.height));event.currentTarget.releasePointerCapture(event.pointerId);const dx=(event.clientX-current.x)*current.sx,dy=(event.clientY-current.y)*current.sy;if(Math.abs(dx)+Math.abs(dy)>.5)onTransform(block.id,current.resize?{width:Math.max(1,block.width+dx),height:Math.max(1,block.height+dy)}:{x:block.x+dx,y:block.y+dy})}}>
   <rect x={block.x} y={block.y} width={block.width} height={block.height} fill="transparent" stroke={selected===block.id?'#1677ff':'#94a3b8'} strokeWidth={selected===block.id?1.5:1} strokeDasharray="5 3"/>
   {selected===block.id&&<rect data-resize="true" x={block.x+block.width-4} y={block.y+block.height-4} width={8} height={8} fill="#fff" stroke="#1677ff" style={{cursor:'nwse-resize'}}/>}
  </g>)}</svg>,surface,page.page)
 })}</>
}
