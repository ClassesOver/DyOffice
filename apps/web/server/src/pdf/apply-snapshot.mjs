import {validatePdfFormFieldOperations} from '../../../../../packages/web-contracts/src/pdf-form-fields.ts'
import {validatePdfStampOperation} from '../../../../../packages/web-contracts/src/pdf-stamp-ops.ts'
import {MAX_PDF_OCR_INSERTS,MAX_PDF_TEXT_INSERTS} from '../../../../../packages/web-contracts/src/pdf-ocr-bake.ts'
import {isPdfAttachmentName,MAX_PDF_ATTACHMENT_ADDITIONS,MAX_PDF_ATTACHMENT_BASE64,MAX_PDF_ATTACHMENT_BYTES} from '../../../../../packages/web-contracts/src/pdf-attachment-limits.ts'
import {decodePdfImage} from './image-content-job.mjs'
import {validatePdfDraftInserts} from './draft-inserts-job.mjs'
import {isWebPdfLinkUrl} from '../../../../pdf/src/shared/web-link-url.ts'
import {EDIT_FONTS} from '../../../../pdf/src/shared/ipc.ts'
import {MAX_PDF_DRAFT_BLANK_PAGES,MAX_PDF_EDIT_PAGES} from '../../../shared/pdf-edit-structure.mjs'
function fail(){throw Object.assign(Error('INVALID_PDF_APPLY_SNAPSHOT'),{code:'INVALID_PDF_APPLY_SNAPSHOT'})}
// DrawLayer records pointer samples until release. Keep room for long strokes
// while the drawing validator still caps the entire batch's coordinate budget.
const MAX_DRAWING_COORDINATES=100_000
const MAX_STROKE_COORDINATES=50_000
function clone(v,depth=0){
 if(depth>52)fail()
 if(!v||typeof v!=='object')return v
 if(Array.isArray(v)){
  if(v.length>MAX_STROKE_COORDINATES||Reflect.ownKeys(v).length!==v.length+1)fail()
  return Array.from({length:v.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!('value'in d)||!d.enumerable)fail();return clone(d.value,depth+1)})
 }
 if(![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail()
 const result=Object.create(null)
 for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=='string'||!d||!('value'in d)||!d.enumerable)fail();result[k]=clone(d.value,depth+1)}return result
}
function obj(v,allowed,required=allowed){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k)))fail();return v}
const num=(v,min=-100000,max=100000)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max
const text=(v,max=10000)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const page=v=>Number.isSafeInteger(v)&&v>=0&&v<MAX_PDF_EDIT_PAGES
function array(v,max=100){if(!Array.isArray(v)||v.length>max)fail();return v}
function vector(v,length,min=-100000,max=100000){if(!Array.isArray(v)||v.length!==length||v.some(x=>!num(x,min,max)))fail();return v}
function rect(v){vector(v,4);if(v[2]<=v[0]||v[3]<=v[1])fail();return v}
function id(v,prefix){if(typeof v!=='string'||v.length<2||v.length>201||!v.startsWith(prefix)||/[\s\u0000-\u001f\u007f]/.test(v))fail()}
function entries(v,prefix,validate,max=100){const seen=new Set();return array(v,max).map(raw=>{const e=obj(raw,['id','input']);id(e.id,prefix);if(seen.has(e.id))fail();seen.add(e.id);validate(e.input);return e})}
function optional(o,k,validate){if(k in o&&!validate(o[k]))fail()}
function textInsert(o){
 obj(o,['pageIndex','origin','text','fontSize','color','font','bold','italic','lineLeading','lineXOffsets','align','rotate','invisible'],['pageIndex','origin','text','fontSize','color'])
 if(!page(o.pageIndex)||!text(o.text)||!o.text.trim()||!num(o.fontSize,0.01,1000))fail();vector(o.origin,2);vector(o.color,3,0,255)
 optional(o,'font',v=>['arial','times','courier'].includes(v));for(const k of ['bold','italic','invisible'])optional(o,k,v=>typeof v==='boolean')
 optional(o,'lineLeading',v=>num(v,0.01,10000));optional(o,'align',v=>['left','center','right'].includes(v));optional(o,'rotate',v=>[0,90,180,270].includes(v))
 if('lineXOffsets'in o){array(o.lineXOffsets,1000);if(o.lineXOffsets.length!==o.text.split('\n').length||o.lineXOffsets.some(v=>!num(v)))fail()}
}
export function validateNativeTextEdits(input){
 const edits=array(clone(input),50),fonts=new Set(EDIT_FONTS.map(font=>font.id))
 for(const e of edits){
  obj(e,['pageIndex','rect','oldText','newText','fontSize','newFontSize','newColor','colorRuns','styleRuns','newFont','origin','lineLeading','lineXOffsets','align','blockSource','newBold','newItalic','translate'],['pageIndex','rect','oldText','newText','fontSize'])
  if(!page(e.pageIndex)||!text(e.oldText)||!e.oldText.trim()||!text(e.newText)||!num(e.fontSize,.01,1000))fail()
  rect(e.rect)
  for(const key of ['origin','translate'])if(key in e)vector(e[key],2)
  if('newColor'in e)vector(e.newColor,3,0,255)
  optional(e,'newFontSize',v=>num(v,.01,1000));optional(e,'lineLeading',v=>num(v,.01,10000))
  optional(e,'newFont',v=>fonts.has(v));optional(e,'align',v=>['left','center','right'].includes(v));optional(e,'blockSource',v=>text(v))
  for(const key of ['newBold','newItalic'])optional(e,key,v=>typeof v==='boolean')
  if('lineXOffsets'in e&&array(e.lineXOffsets,1000).some(value=>!num(value)))fail()
  for(const key of ['colorRuns','styleRuns'])if(key in e){
   let previous=0
   for(const run of array(e[key],1000)){
    obj(run,key==='colorRuns'?['start','end','color']:['start','end','color','font','size','bold','italic'],key==='colorRuns'?['start','end','color']:['start','end'])
    if(!Number.isSafeInteger(run.start)||!Number.isSafeInteger(run.end)||run.start<previous||run.start>=run.end||run.end>e.newText.length)fail()
    previous=run.end
    if('color'in run)vector(run.color,3,0,255)
    optional(run,'font',v=>fonts.has(v));optional(run,'size',v=>num(v,.01,1000))
    for(const property of ['bold','italic'])optional(run,property,v=>typeof v==='boolean')
   }
  }
 }
 return JSON.parse(JSON.stringify(edits))
}
function imageEdit(o){
 const kinds={insertImage:['kind','pageIndex','image','rect','layer','rotate'],replaceImage:['kind','pageIndex','oldRect','image','rect','layer','quarterTurns'],transformImage:['kind','pageIndex','oldRect','rect','layer','quarterTurns'],deleteImage:['kind','pageIndex','oldRect']}
 if(!o||typeof o.kind!=='string'||!Object.hasOwn(kinds,o.kind))fail();obj(o,kinds[o.kind],['kind','pageIndex',...(o.kind==='deleteImage'?['oldRect']:['rect']),...(['insertImage','replaceImage'].includes(o.kind)?['image']:[]),...(o.kind==='insertImage'?['layer']:[])])
 if(!page(o.pageIndex))fail();if('rect'in o)rect(o.rect);if(o.kind!=='insertImage')rect(o.oldRect)
 optional(o,'layer',v=>['aboveText','belowText'].includes(v));optional(o,'rotate',v=>[0,90,180,270].includes(v));optional(o,'quarterTurns',v=>[0,1,2,3].includes(v))
 if('image'in o){if(typeof o.image!=='string'||o.image.length>7*1024*1024||!o.image.length)fail();try{decodePdfImage({mime:Buffer.from(o.image,'base64')[0]===255?'image/jpeg':'image/png',base64:o.image})}catch{fail()}}
}

const drawingProperties={
 ink:['paths','width','color','formFieldName'],rect:['rect','width','color'],ellipse:['rect','width','color'],
 line:['from','to','width','color'],arrow:['from','to','width','color'],measure:['from','to','label','width','color'],
 caret:['point','color'],polygon:['vertices','width','color'],image:['rect','image','formFieldName'],link:['rect','url','destPage'],
}
function validateDrawings(drawings){
 let coordinates=0
 for(const drawing of array(drawings)){
  if(!drawing||!Object.hasOwn(drawingProperties,drawing.kind))fail()
  const properties=drawingProperties[drawing.kind],base=['kind','pageIndex']
  obj(drawing,[...base,...properties],[...base,...properties.filter(key=>!['formFieldName','url','destPage'].includes(key))])
  if(!page(drawing.pageIndex))fail()
  if('color'in drawing)vector(drawing.color,3,0,1)
  if('width'in drawing&&!num(drawing.width,.01,100))fail()
  if('rect'in drawing)rect(drawing.rect)
  optional(drawing,'formFieldName',v=>text(v,1024)&&!!v)
  switch(drawing.kind){
   case 'ink':
    if(!array(drawing.paths).length)fail()
    for(const path of drawing.paths){
     if(array(path,MAX_STROKE_COORDINATES).length<4||path.length%2||path.some(value=>!num(value)))fail()
     coordinates+=path.length
    }
    break
   case 'polygon':
    if(array(drawing.vertices,500).length<3)fail()
    for(const point of drawing.vertices)vector(point,2)
    coordinates+=drawing.vertices.length*2
    break
   case 'measure':
    if(!text(drawing.label,64)||/[\r\n\t]/.test(drawing.label)||!drawing.label.trim())fail()
    // The measurement, line and arrow use the same endpoint format.
   case 'line': case 'arrow':
    vector(drawing.from,2);vector(drawing.to,2)
    break
   case 'caret':
    vector(drawing.point,2)
    break
   case 'link':
    if(('url'in drawing)===('destPage'in drawing))fail()
    if('url'in drawing?!isWebPdfLinkUrl(drawing.url):!Number.isSafeInteger(drawing.destPage)||!page(drawing.destPage-1))fail()
    break
   case 'image':
    try{decodePdfImage({mime:'image/png',base64:drawing.image})}catch{fail()}
    break
  }
 }
 if(coordinates>MAX_DRAWING_COORDINATES)fail()
}
function validateOutline(outline){
 let count=0
 function walk(list,depth){
  for(const item of array(list,500)){
   if(++count>500||depth>24)fail()
   obj(item,['title','pageIndex','top','children'],['title','pageIndex'])
   if(!text(item.title,1000)||!item.title.trim()||!page(item.pageIndex))fail()
   optional(item,'top',v=>v===null||num(v))
   if('children'in item)walk(item.children,depth+1)
  }
 }
 walk(outline,1)
}
function validateFormWidgetEdits(edits){
 const ids=new Set()
 for(const edit of array(edits)){
  obj(edit,['widgetId','fieldName','rect','required','remove'],['widgetId','fieldName'])
  if(typeof edit.widgetId!=='string'||!/^([1-9]\d{0,9})R(?:[1-9]\d{0,4})?$/.test(edit.widgetId)||ids.has(edit.widgetId)||!text(edit.fieldName,1024)||!edit.fieldName)fail()
  optional(edit,'required',v=>typeof v==='boolean')
  optional(edit,'remove',v=>typeof v==='boolean')
  if('rect'in edit)rect(edit.rect)
  if(!edit.remove&&!('rect'in edit)&&!('required'in edit))fail()
  ids.add(edit.widgetId)
 }
}
function validateStaticFormFills(fills){
 const ids=new Set()
 for(const fill of array(fills,1000)){
  obj(fill,['id','kind','pageIndex','rect','text','fontSize','color','align'],['id','kind','pageIndex','rect'])
  if(!text(fill.id,201)||!fill.id||ids.has(fill.id)||!page(fill.pageIndex)||!['text','check','cross'].includes(fill.kind))fail()
  ids.add(fill.id)
  rect(fill.rect)
  optional(fill,'text',v=>text(v))
  optional(fill,'fontSize',v=>num(v,0.01,1000))
  optional(fill,'color',v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v))
  optional(fill,'align',v=>['left','center','right'].includes(v))
 }
}
export function validatePdfApplySnapshot(input){
 const s=clone(input),required=['fileId','baseRevision','generation','markups','notes','textInserts','imageEdits','formEdits','formFields','rotations','deleted','order','metadata'];obj(s,[...required,'savedImageEdits','annotationAuthor','blankPages','textEdits','annotDeletes','noteEdits','stampOperations','attachments','drawings','outline','formWidgetEdits','staticFormFills'],required)
 if('drawings'in s)validateDrawings(s.drawings)
 if('outline'in s)validateOutline(s.outline)
 if('formWidgetEdits'in s)validateFormWidgetEdits(s.formWidgetEdits)
 if('staticFormFills'in s)validateStaticFormFills(s.staticFormFills)
 if('attachments'in s){
  const edits=obj(s.attachments,['add','remove'],[]),added=new Set(),removed=new Set()
  let bytes=0
  for(const file of ('add'in edits?array(edits.add,MAX_PDF_ATTACHMENT_ADDITIONS):[])){
   obj(file,['name','bytesBase64','description'],['name','bytesBase64'])
   if(typeof file.name!=='string'||!isPdfAttachmentName(file.name)||added.has(file.name))fail()
   optional(file,'description',v=>text(v,1000))
   if(typeof file.bytesBase64!=='string'||file.bytesBase64.length>MAX_PDF_ATTACHMENT_BASE64)fail()
   const content=Buffer.from(file.bytesBase64,'base64')
   bytes+=content.length
   if(bytes>MAX_PDF_ATTACHMENT_BYTES||content.toString('base64')!==file.bytesBase64)fail()
   added.add(file.name)
  }
  for(const name of ('remove'in edits?array(edits.remove,100):[])){
   if(!text(name,1024)||!name||removed.has(name))fail()
   removed.add(name)
  }
 }
 if('stampOperations'in s){
  try{s.stampOperations=array(s.stampOperations,2).map(validatePdfStampOperation)}catch{fail()}
  if(new Set(s.stampOperations.map(operation=>operation.op)).size!==s.stampOperations.length)fail()
 }
 if('textEdits'in s)s.textEdits=validateNativeTextEdits(s.textEdits)
 const addressed=new Set()
 for(const key of ['annotDeletes','noteEdits'])if(key in s)for(const item of array(s[key])){
  const base=['pageIndex','objNum','rect']
  const editing=key==='noteEdits'
  obj(item,editing?[...base,'oldContents','contents']:[...base,'subtype','contents'],[...base,...(editing?['oldContents','contents']:['subtype'])])
  if(!page(item.pageIndex)||!Number.isSafeInteger(item.objNum)||item.objNum<1||addressed.has(item.objNum))fail()
  addressed.add(item.objNum);rect(item.rect)
  if(editing){if(!text(item.oldContents)||!text(item.contents)||!item.contents.trim())fail()}
  else if(!['highlight','underline','squiggly','strikeout','note','polygon'].includes(item.subtype)||item.subtype==='note'&&!text(item.contents)||'contents'in item&&!text(item.contents))fail()
 }
 if('blankPages'in s)for(const item of array(s.blankPages,MAX_PDF_DRAFT_BLANK_PAGES)){
  obj(item,['pageIndex','width','height']);if(!page(item.pageIndex)||!num(item.width,1,14400)||!num(item.height,1,14400))fail()
 }
 optional(s,'annotationAuthor',v=>text(v,200)&&!!v.trim())
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
 if(typeof s.fileId!=='string'||typeof s.baseRevision!=='string'||!uuid.test(s.fileId)||!uuid.test(s.baseRevision)||!Number.isSafeInteger(s.generation)||s.generation<0||s.generation>=Number.MAX_SAFE_INTEGER)fail()
 const ids=new Set()
 for(const m of array(s.markups)){obj(m,['id','pageIndex','type','color','quads']);id(m.id,'P');if(ids.has(m.id))fail();ids.add(m.id);if(!page(m.pageIndex)||!['highlight','underline','squiggly','strikeout'].includes(m.type))fail();vector(m.color,3,0,1);if(!array(m.quads,1000).length)fail();m.quads.forEach(q=>vector(q,8))}
 s.notes=entries(s.notes,'P',o=>{
  obj(o,['kind','pageIndex','color','at','contents','author','createdMs','localId','replyToSaved','replyToLocalId'],['kind','pageIndex','color','at','contents']);if(o.kind!=='note'||!page(o.pageIndex)||!text(o.contents,10000)||!o.contents.trim())fail();vector(o.color,3,0,1);vector(o.at,2)
  optional(o,'author',v=>text(v,200));optional(o,'createdMs',v=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000);optional(o,'localId',v=>typeof v==='string'&&v.length>0&&v.length<=201);optional(o,'replyToLocalId',v=>typeof v==='string'&&v.length>0&&v.length<=201)
  if('replyToSaved'in o){obj(o.replyToSaved,['objNum','rect','contents']);if(!Number.isSafeInteger(o.replyToSaved.objNum)||o.replyToSaved.objNum<1||!text(o.replyToSaved.contents,10000))fail();rect(o.replyToSaved.rect)}
  if('replyToSaved'in o&&'replyToLocalId'in o)fail()
 })
 for(const note of s.notes){if(ids.has(note.id))fail();ids.add(note.id)}
 s.textInserts=entries(s.textInserts,'T',textInsert,MAX_PDF_OCR_INSERTS+MAX_PDF_TEXT_INSERTS);s.imageEdits=entries(s.imageEdits,'I',imageEdit,20)
 const visibleText=s.textInserts.filter(e=>e.input.invisible!==true).length
 if(visibleText>MAX_PDF_TEXT_INSERTS||s.textInserts.length-visibleText>MAX_PDF_OCR_INSERTS)fail()
 if('savedImageEdits'in s){
  array(s.savedImageEdits,20)
  if(s.savedImageEdits.length)try{s.savedImageEdits=validatePdfDraftInserts({texts:[],images:[],imageEdits:s.savedImageEdits}).imageEdits}catch{fail()}
 }
 const savedImages=s.savedImageEdits??[]
 if([...s.imageEdits.map(e=>e.input.image),...savedImages.map(e=>e.image?.base64),...(s.drawings??[]).map(drawing=>drawing.image)].reduce((sum,image)=>sum+(image?Buffer.byteLength(image,'base64'):0),0)>20*1024*1024)fail()
 obj(s.formEdits,Object.keys(s.formEdits));if(Object.keys(s.formEdits).length>100)fail()
 for(const [name,v]of Object.entries(s.formEdits)){obj(v,['name','kind','value','checked'],['name','kind']);if(name!==v.name||!text(name,1024)||!name||!['text','checkbox','radio','choice'].includes(v.kind))fail();if(v.kind==='checkbox'){if(typeof v.checked!=='boolean'||'value'in v)fail()}else if(!text(v.value)||'checked'in v)fail()}
 s.formFields=entries(s.formFields,'F',o=>{
  obj(o,['name','kind','pageIndex','rect','required','multiLine','maxLen','fontSize','textAlignment','value','checked','exportValue','options','dateFormat'],['name','kind','pageIndex','rect']);if(!page(o.pageIndex))fail();rect(o.rect)
 },50)
 // Reuse the field attribute contract without changing native rectangle units.
 try{if(s.formFields.length)validatePdfFormFieldOperations(s.formFields.map(({input:o})=>{const {pageIndex,rect,...rest}=o;return {op:'addFormField',field:{...rest,page:pageIndex+1,x:0,y:0,width:rect[2]-rect[0],height:rect[3]-rect[1]}}}))}catch{fail()}
 obj(s.rotations,Object.keys(s.rotations));for(const [p,r]of Object.entries(s.rotations))if(!/^(0|[1-9]\d?)$/.test(p)||![90,180,270].includes(r))fail()
 array(s.deleted);if(s.deleted.some(p=>!page(p))||new Set(s.deleted).size!==s.deleted.length)fail()
 if(s.order!==null){array(s.order);if(!s.order.length||s.order.some(p=>!page(p))||new Set(s.order).size!==s.order.length)fail()}
 if(s.metadata!==null){obj(s.metadata,['title','author','subject','keywords'],[]);if(Object.values(s.metadata).some(v=>!text(v,4000)))fail()}
 // Bound aggregate state independently of the per-tool limits.
 if(s.markups.length+s.notes.length+(s.drawings?.length??0)+(s.formWidgetEdits?.length??0)+visibleText+s.imageEdits.length+savedImages.length+s.formFields.length+Object.keys(s.formEdits).length>250)fail()
 return JSON.parse(JSON.stringify(s))
}
