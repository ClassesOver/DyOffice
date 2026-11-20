import {useRef} from 'react'
import {createPortal} from 'react-dom'
import type {PdfTextDraftInfo,PreviewPage} from '../shell/pdf-preview-skill'

/** Coordinates and line widths come from the same font planner used at save time. */
export function PdfTextDraftOverlay({host,pages,blocks,selected,disabled,onSelect,onMove,onDelete,rasterPages}:{host:HTMLElement|null;pages:readonly PreviewPage[];blocks:readonly PdfTextDraftInfo[];selected:string;disabled:boolean;onSelect:(id:string)=>void;onMove:(id:string,dx:number,dy:number)=>void;onDelete:(id:string)=>void;rasterPages?:ReadonlySet<number>}){
 const drag=useRef<{id:string;x:number;y:number;scaleX:number;scaleY:number;node:SVGGElement}|null>(null)
 return <>{pages.map(page=>{
  const surface=host?.querySelector<HTMLElement>(`figure[data-pdf-page="${page.page}"] .pdf-page-surface`),items=blocks.filter(block=>block.page===page.page)
  if(!surface||!items.length||!page.width||!page.height)return null
  return createPortal(<svg aria-label="待保存文字覆盖层" viewBox={`0 0 ${page.width} ${page.height}`} style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',overflow:'visible',zIndex:1}}>
   {items.map(block=><g key={block.id} role="button" tabIndex={disabled?-1:0} aria-label={`待保存文字 ${block.id}`} aria-pressed={selected===block.id} style={{pointerEvents:disabled?'none':'auto',cursor:'move',touchAction:'none',outline:'none'}}
    onFocus={()=>onSelect(block.id)} onClick={()=>onSelect(block.id)}
    onKeyDown={event=>{if(disabled)return;const steps:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(steps[event.key]){event.preventDefault();const [x,y]=steps[event.key];onMove(block.id,x*(event.shiftKey?10:1),y*(event.shiftKey?10:1))}else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();onDelete(block.id)}else if(event.key==='Enter'){event.preventDefault();onSelect(block.id)}}}
    onPointerDown={event=>{if(disabled||event.button!==0)return;event.preventDefault();event.currentTarget.focus();onSelect(block.id);const bounds=event.currentTarget.ownerSVGElement!.getBoundingClientRect();if(!bounds.width||!bounds.height)return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:block.id,x:event.clientX,y:event.clientY,scaleX:page.width!/bounds.width,scaleY:page.height!/bounds.height,node:event.currentTarget}}}
    onPointerMove={event=>{const current=drag.current;if(current?.id===block.id)current.node.setAttribute('transform',`translate(${(event.clientX-current.x)*current.scaleX} ${(event.clientY-current.y)*current.scaleY})`)}}
    onPointerCancel={()=>{drag.current?.node.removeAttribute('transform');drag.current=null}}
    onPointerUp={event=>{const current=drag.current;if(current?.id!==block.id)return;drag.current=null;current.node.removeAttribute('transform');event.currentTarget.releasePointerCapture(event.pointerId);const dx=(event.clientX-current.x)*current.scaleX,dy=(event.clientY-current.y)*current.scaleY;if(Math.abs(dx)+Math.abs(dy)>.5)onMove(block.id,dx,dy)}}>
    <rect x={block.x} y={block.y} width={block.width} height={block.height} fill={selected===block.id?'#1677ff0d':'transparent'} stroke={selected===block.id?'#1677ff':'#94a3b8'} strokeDasharray="4 3"/>
    {!rasterPages?.has(block.page)&&block.text.split('\n').map((line,index)=><text key={index} x={block.x+(block.align==='center'?block.width/2:block.align==='right'?block.width:0)} y={block.y+block.font_size+index*block.font_size*1.2} fontSize={block.font_size} fill={block.color} fontFamily={block.font==='times'?'Times New Roman,serif':block.font==='courier'?'Courier New,monospace':'Arial,sans-serif'} fontWeight={block.bold?'bold':'normal'} fontStyle={block.italic?'italic':'normal'} textAnchor={block.align==='center'?'middle':block.align==='right'?'end':'start'} {...(block.line_widths?.[index]?{textLength:block.line_widths[index],lengthAdjust:'spacingAndGlyphs' as const}:{})} style={{userSelect:'none',pointerEvents:'none'}}>{line}</text>)}
   </g>)}
  </svg>,surface,page.page)
 })}</>
}
