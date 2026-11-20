import type {PDFPageProxy} from 'pdfjs-dist'
import {foldCase} from '../../../../packages/ui/src/find-text'
import {geomDispSize,pdfRectToCss,viewToPdf,type PageGeom} from '../../../pdf/src/renderer/annotations'
import {collectDetectInput} from '../../../pdf/src/renderer/form-detect'
import {checkboxWidgetAt,printedBoxAt,markRectForBox} from '../../../pdf/src/renderer/form-mark-target'
import type {FormWidget} from '../../../pdf/src/renderer/form-catalog'
import {renderStaticFormMark,STATIC_FORM_MARK_SIZE} from '../../../pdf/src/renderer/static-form-fill'

export type PdfFormMarkInput={page:number;kind:'check'|'cross';size?:number;anchor_text?:string;placement?:'left'|'right'|'above'|'below';x?:number;y?:number}
export type PdfFormMarkPlan={kind:'checkbox';name:string}|{kind:'image';x:number;y:number;width:number;height:number;image:{mime:'image/png';base64:string}}

export function validatePdfFormMark(input:unknown):PdfFormMarkInput{
 if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('Invalid form mark input')
 const value:Record<string,unknown>={}
 for(const key of Reflect.ownKeys(input)){
  const descriptor=Object.getOwnPropertyDescriptor(input,key)
  if(typeof key!=='string'||!['page','kind','size','anchor_text','placement','x','y'].includes(key)||!descriptor?.enumerable||!('value' in descriptor))throw new Error('Invalid form mark field')
  value[key]=descriptor.value
 }
 if(typeof value.page!=='number'||!Number.isSafeInteger(value.page)||value.page<1)throw new Error('page must be a positive integer')
 if(value.kind!=='check'&&value.kind!=='cross')throw new Error("kind must be 'check' or 'cross'")
 for(const key of ['x','y','size'] as const)if(value[key]!==undefined&&(typeof value[key]!=='number'||!Number.isFinite(value[key])))throw new Error(`${key} must be a finite number`)
 if(value.size!==undefined&&(!(Number(value.size)>0)||Number(value.size)>1000))throw new Error('size must be positive and at most 1000')
 if(value.anchor_text!==undefined&&(typeof value.anchor_text!=='string'||!value.anchor_text.trim()||value.anchor_text.length>2000))throw new Error('anchor_text must contain 1 to 2000 characters')
 if(value.placement!==undefined&&(typeof value.placement!=='string'||!['left','right','above','below'].includes(value.placement)))throw new Error('Invalid placement')
 if(value.anchor_text===undefined&&value.x===undefined&&value.y===undefined)throw new Error('Position the mark with anchor_text or x/y')
 return {page:value.page,kind:value.kind,...(value.size===undefined?{}:{size:value.size as number}),...(value.x===undefined?{}:{x:value.x as number}),...(value.y===undefined?{}:{y:value.y as number}),...(value.anchor_text===undefined?{}:{anchor_text:(value.anchor_text as string).trim()}),...(value.placement===undefined?{}:{placement:value.placement as NonNullable<PdfFormMarkInput['placement']>})}
}
const check=(signal?:AbortSignal)=>{if(signal?.aborted)throw new DOMException('The form mark was cancelled','AbortError')}

async function anchorRect(page:PDFPageProxy,anchor:string,signal?:AbortSignal):Promise<[number,number,number,number]>{
 const content=await page.getTextContent();check(signal)
 let text=''
 const runs:{start:number;end:number;x:number;y:number;w:number;h:number}[]=[]
 for(const raw of content.items){
  if(!('str' in raw))continue
  if(raw.str.length&&raw.transform){
   const h=raw.height||Math.hypot(raw.transform[2]??0,raw.transform[3]??0)
   runs.push({start:text.length,end:text.length+raw.str.length,x:raw.transform[4]??0,y:raw.transform[5]??0,w:raw.width,h})
  }
  text+=raw.str
  if(raw.hasEOL)text+='\n'
 }
 const start=foldCase(text).indexOf(foldCase(anchor)),end=start+anchor.length
 if(start<0)throw new Error(`"${anchor}" not found on page ${page.pageNumber}; use read_pages to verify the exact text`)
 let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity
 for(const run of runs){
  if(run.end<=start||run.start>=end)continue
  x1=Math.min(x1,run.x+run.w*(Math.max(start,run.start)-run.start)/(run.end-run.start))
  x2=Math.max(x2,run.x+run.w*(Math.min(end,run.end)-run.start)/(run.end-run.start))
  y1=Math.min(y1,run.y);y2=Math.max(y2,run.y+run.h)
 }
 if(![x1,y1,x2,y2].every(Number.isFinite)||x2-x1<.01||y2<=y1)throw new Error('Anchor text geometry is unavailable')
 return [x1,y1,x2,y2]
}

/** Plans in displayed points; only the caller mutates or saves the document. */
export async function planPdfFormMark(page:PDFPageProxy,input:PdfFormMarkInput,widgets:readonly FormWidget[],signal?:AbortSignal):Promise<PdfFormMarkPlan>{
 const value=validatePdfFormMark(input);check(signal)
 const [rawX0,rawY0,rawX1,rawY1]=page.view,unit=page.userUnit??1
 const x0=rawX0??0,y0=rawY0??0,x1=rawX1??0,y1=rawY1??0
 if(![x0,y0,x1,y1,unit,page.rotate].every(Number.isFinite)||unit<=0||x1<=x0||y1<=y0||page.rotate%90!==0)throw new Error('Invalid page geometry')
 const geom:PageGeom={pw:(x1-x0)*unit,ph:(y1-y0)*unit,x0,y0,rot:page.rotate,userUnit:unit}
 const size=value.size??STATIC_FORM_MARK_SIZE,display=geomDispSize(geom)
 let x=value.x??0,y=value.y??0
 if(value.anchor_text){
  const box=pdfRectToCss(geom,await anchorRect(page,value.anchor_text,signal),1),gap=4
  if(value.placement==='above'){x=box.left+(box.width-size)/2;y=box.top-gap-size}
  else if(value.placement==='below'){x=box.left+(box.width-size)/2;y=box.top+box.height+gap}
  else if(value.placement==='left'){x=box.left-gap-size;y=box.top+(box.height-size)/2}
  else{x=box.left+box.width+gap;y=box.top+(box.height-size)/2}
 }
 x=Math.min(Math.max(x,0),Math.max(display.width-size,0));y=Math.min(Math.max(y,0),Math.max(display.height-size,0))
 check(signal)
 const [px,py]=viewToPdf(geom,x+size/2,y+size/2),slack=size/(2*unit)
 const pageWidgets=widgets.filter(widget=>widget.pageIndex===value.page-1)
 const hits=pageWidgets.filter(({rect})=>px>=Math.min(rect[0],rect[2])&&px<=Math.max(rect[0],rect[2])&&py>=Math.min(rect[1],rect[3])&&py<=Math.max(rect[1],rect[3]))
 if(hits.some(widget=>widget.readOnly))throw new Error('The form field at that position is read-only')
 if(hits.some(widget=>widget.kind!=='checkbox'))throw new Error('That position is an interactive form field; use setFormValue instead of drawing a mark')
 const widget=checkboxWidgetAt(pageWidgets,px,py,slack)
 if(widget)return {kind:'checkbox',name:widget.fieldName}
 const detected=await collectDetectInput(page);check(signal)
 const printed=printedBoxAt(detected.shapes,px,py,slack)
 const target=printed?pdfRectToCss(geom,markRectForBox(printed),1):{left:x,top:y,width:size,height:size}
 const rendered=renderStaticFormMark(value.kind,target.width)
 if(!rendered?.image)throw new Error('Could not render the form mark')
 check(signal)
 return {kind:'image',x:target.left,y:target.top,width:target.width,height:target.height,image:{mime:'image/png',base64:rendered.image}}
}
