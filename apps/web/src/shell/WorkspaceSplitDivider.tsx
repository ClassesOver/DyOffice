import {useLayoutEffect,useRef,useState} from 'react'
import type {KeyboardEvent,PointerEvent} from 'react'

import {splitWidths} from './document-tabs'

const {minimum,maximum,default:midpoint}=splitWidths
const step=5
const widthProperty='--workspace-left-pane-width'

function clamp(value:number){
 return Math.max(minimum,Math.min(maximum,Math.round(value)))
}

export function WorkspaceSplitDivider({disabled,initialWidth=midpoint,onResize}:{disabled:boolean;initialWidth?:number|undefined;onResize:(width:number)=>void}){
 const handle=useRef<HTMLDivElement>(null)
 const pointer=useRef<number|null>(null)
 const [width,setWidth]=useState(initialWidth)
 const [dragging,setDragging]=useState(false)

 useLayoutEffect(()=>{
  const workspace=handle.current?.parentElement
  return()=>{workspace?.style.removeProperty(widthProperty)}
 },[])
 useLayoutEffect(()=>{
  handle.current?.parentElement?.style.setProperty(widthProperty,`${width}%`)
 },[width])
 useLayoutEffect(()=>{
  if(!dragging)onResize(width)
 },[dragging,onResize,width])


 function start(event:PointerEvent<HTMLDivElement>){
  if(disabled||!event.isPrimary||event.button!==0)return
  event.currentTarget.focus()
  event.currentTarget.setPointerCapture(event.pointerId)
  pointer.current=event.pointerId
  setDragging(true)
 }
 function move(event:PointerEvent<HTMLDivElement>){
  if(disabled||pointer.current!==event.pointerId)return
  const bounds=event.currentTarget.parentElement?.getBoundingClientRect()
  if(bounds?.width)setWidth(clamp((event.clientX-bounds.left)/bounds.width*100))
 }
 function finish(event:PointerEvent<HTMLDivElement>){
  if(pointer.current!==event.pointerId)return
  pointer.current=null
  setDragging(false)
 }
 function resizeFromKeyboard(event:KeyboardEvent<HTMLDivElement>){
  if(disabled||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return
  switch(event.key){
   case 'ArrowLeft':setWidth(value=>clamp(value-step));break
   case 'ArrowRight':setWidth(value=>clamp(value+step));break
   case 'Home':setWidth(minimum);break
   case 'End':setWidth(maximum);break
   case 'Enter':setWidth(midpoint);break
   default:return
  }
  event.preventDefault()
 }
 return <div ref={handle} className="workspace-split-divider" role="separator"
  aria-label="调整并排窗格宽度" aria-orientation="vertical"
  aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width} aria-disabled={disabled||undefined}
  tabIndex={disabled?-1:0} data-dragging={dragging||undefined}
  onPointerDown={start} onPointerMove={move} onLostPointerCapture={finish}
  onKeyDown={resizeFromKeyboard} onDoubleClick={()=>{if(!disabled)setWidth(midpoint)}}/>
}
