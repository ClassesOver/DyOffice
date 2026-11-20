import {PDFArray,PDFDict,PDFName,PDFRef,PDFString,PDFHexString,PDFRadioGroup,PDFCheckBox} from 'pdf-lib'
const n=PDFName.of
function fail(){throw Object.assign(Error('PDF_EDIT_UNSUPPORTED_STRUCTURE'),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})}
const widget=dict=>String(dict.lookup(n('Subtype')))==='/Widget'
/** Run before page deletion, on the same PDFDocument whose original page refs were captured.
 * Preflight the complete tree and widget ownership before making any changes.
 * Detached indirect objects are left in context; only reachable form/page arrays are rewritten.
 */
export function cleanupDeletedPageForms(doc,deletedPageRefs){
 try{cleanup(doc,deletedPageRefs)}catch{fail()}
}
function cleanup(doc,deletedPageRefs){
 if(!Array.isArray(deletedPageRefs)||deletedPageRefs.length>100||Reflect.ownKeys(deletedPageRefs).length!==deletedPageRefs.length+1)fail()
 const deleted=new Set()
 for(let i=0;i<deletedPageRefs.length;i++){
  const d=Object.getOwnPropertyDescriptor(deletedPageRefs,String(i))
  if(!d||!('value'in d)||typeof d.value!=='string'||!/^\d+ \d+ R$/.test(d.value)||deleted.has(d.value))fail()
  deleted.add(d.value)
 }
 if(!deleted.size)return
 const pages=doc.getPages(),pageRefs=new Set(pages.map(p=>String(p.ref)))
 if([...deleted].some(ref=>!pageRefs.has(ref)))fail()
 const locations=new Map(),annotsByPage=[]
 for(const page of pages){
  const annots=page.node.lookup(n('Annots'));if(annots!==undefined&&!(annots instanceof PDFArray))fail()
  annotsByPage.push({page,annots})
  for(const raw of annots?.asArray()??[]){
   const dict=doc.context.lookup(raw);if(!(dict instanceof PDFDict))fail()
   if(!widget(dict))continue
   if(!(raw instanceof PDFRef)||locations.has(dict))fail()
   locations.set(dict,String(page.ref))
  }
 }
 const acro=doc.catalog.lookup(n('AcroForm'))
 if(acro===undefined){if(locations.size)fail();return}
 if(!(acro instanceof PDFDict)||acro.has(n('XFA')))fail()
 const roots=acro.lookup(n('Fields'))
 if(roots===undefined){if(locations.size)fail();return}
 if(!(roots instanceof PDFArray))fail()
 const nodes=new Map(),seenDicts=new Set(),leaves=[],owned=new Set()
 function resolve(raw){if(!(raw instanceof PDFRef))fail();const dict=doc.context.lookup(raw);if(!(dict instanceof PDFDict))fail();return dict}
 function parent(dict,expected){const raw=dict.get(n('Parent'));if(expected?!(raw instanceof PDFRef)||String(raw)!==String(expected):raw!==undefined)fail()}
 function addWidget(raw,dict,fieldRef,merged=false){
  if(owned.has(dict))fail();owned.add(dict)
  if(!merged)parent(dict,fieldRef)
  const rawPage=dict.get(n('P'));let declared
  if(rawPage!==undefined){if(!(rawPage instanceof PDFRef)||!pageRefs.has(String(rawPage)))fail();declared=String(rawPage)}
  const listed=locations.get(dict)
  if(declared&&listed&&declared!==listed||!declared&&!listed)fail()
  return {raw,dict,page:declared??listed}
 }
 function walk(raw,expected,depth=0){
  if(depth>64||nodes.size>=10000)fail()
  const dict=resolve(raw),key=String(raw)
  if(nodes.has(key)||seenDicts.has(dict)||!dict.has(n('T')))fail();seenDicts.add(dict);parent(dict,expected)
  const title=dict.lookup(n('T'));if(!(title instanceof PDFString||title instanceof PDFHexString))fail()
  const kids=dict.lookup(n('Kids'));if(kids!==undefined&&!(kids instanceof PDFArray))fail()
  const children=kids?.asArray()??[],childDicts=children.map(resolve),isBranch=childDicts.some(d=>d.has(n('T')))
  const node={raw,dict,children:[],widgets:[]};nodes.set(key,node)
  if(isBranch){
   if(widget(dict)||childDicts.some(d=>!d.has(n('T'))))fail()
   node.children=children.map(child=>walk(child,raw,depth+1))
  }else{
   if(widget(dict)){
    if(children.length)fail();node.widgets=[addWidget(raw,dict,raw,true)]
   }else{
    if(childDicts.some(d=>!widget(d)||d.has(n('FT'))))fail()
    node.widgets=children.map((child,i)=>addWidget(child,childDicts[i],raw))
   }
   leaves.push(node)
  }
  return node
 }
 for(const raw of roots.asArray())walk(raw,undefined)
 if([...locations.keys()].some(dict=>!owned.has(dict)))fail()
 const form=doc.getForm(),fields=new Map(form.getFields().map(f=>[String(f.ref),f]))
 if(fields.size!==leaves.length||new Set([...fields.values()].map(f=>f.getName())).size!==fields.size||leaves.some(node=>!fields.has(String(node.raw))))fail()
 const co=acro.lookup(n('CO'))
 if(co!==undefined&&(!(co instanceof PDFArray)||co.asArray().some(raw=>!(raw instanceof PDFRef)||!nodes.has(String(raw)))))fail()
 const removedWidgets=new Set(),plans=[]
 for(const leaf of leaves){
  const indices=leaf.widgets.flatMap((w,i)=>deleted.has(w.page)?[i]:[])
  if(!indices.length)continue
  const field=fields.get(String(leaf.raw)),keep=leaf.widgets.filter((_,i)=>!indices.includes(i)),plan={field,indices,remove:!keep.length,clear:false,clearDefault:false,opt:false}
  for(const i of indices)removedWidgets.add(leaf.widgets[i].dict)
  if(keep.length&&(field instanceof PDFRadioGroup||field instanceof PDFCheckBox)){
   const acroField=field.acroField,all=acroField.getWidgets(),on=all.map(w=>{
    const appearance=w.dict.lookup(n('AP'));if(!(appearance instanceof PDFDict))fail()
    const normal=appearance.lookup(n('N'));if(!(normal instanceof PDFDict))fail()
    const values=normal.keys().filter(key=>key!==n('Off'));if(values.length!==1||!normal.has(n('Off')))fail()
    return values[0]
   })
   const selected=acroField.V()??n('Off');if(!(selected instanceof PDFName)||selected!==n('Off')&&!on.includes(selected))fail()
   for(let i=0;i<all.length;i++)if(all[i].getAppearanceState()!==(on[i]===selected?selected:n('Off')))fail()
   const opt=acroField.Opt()
   if(opt!==undefined){
    const values=opt instanceof PDFArray?opt.asArray():[opt]
    if(values.length!==all.length||values.some(raw=>{const v=doc.context.lookup(raw);return !(v instanceof PDFString||v instanceof PDFHexString)}))fail()
    const labels=new Map()
    for(let i=0;i<values.length;i++){const label=doc.context.lookup(values[i]).decodeText(),prior=labels.get(on[i]);if(prior!==undefined&&prior!==label)fail();labels.set(on[i],label)}
    plan.opt=true
   }
   const keptOn=on.filter((_,i)=>!indices.includes(i));plan.clear=selected!==n('Off')&&!keptOn.includes(selected)
   const defaultValue=leaf.dict.lookup(n('DV'))
   if(defaultValue!==undefined){if(!(defaultValue instanceof PDFName)||defaultValue!==n('Off')&&!on.includes(defaultValue))fail();plan.clearDefault=defaultValue!==n('Off')&&!keptOn.includes(defaultValue)}
  }
  plans.push(plan)
 }
 // Detach only arrays that will be changed: PDF arrays can be shared via indirect refs.
 const detached=new Map()
 function detachArray(dict,key){
  let keys=detached.get(dict);if(keys?.has(key))return
  const array=dict.lookup(n(key));if(!(array instanceof PDFArray))fail()
  dict.set(n(key),doc.context.obj(array.asArray()))
  if(!keys){keys=new Set();detached.set(dict,keys)}keys.add(key)
 }
 // All ownership/tree checks have completed; public Acro APIs preserve parent refs and AP objects.
 for(const plan of plans){
  const field=plan.field
  if(plan.remove){
   let parent=field.acroField.getParent()
   while(parent){detachArray(parent.dict,'Kids');parent=parent.getParent()}
   detachArray(acro,'Fields');form.acroForm.removeField(field.acroField);continue
  }
  detachArray(field.acroField.dict,'Kids')
  if(plan.opt&&field.acroField.Opt() instanceof PDFArray)detachArray(field.acroField.dict,'Opt')
  for(const i of [...plan.indices].reverse()){
   if(plan.opt)field.acroField.removeExportValue(i)
   field.acroField.removeWidget(i)
  }
  if(plan.clear)field.acroField.setValue(n('Off'))
  if(plan.clearDefault)field.acroField.dict.set(n('DV'),n('Off'))
 }
 for(const {page,annots}of annotsByPage)if(annots){
  const kept=annots.asArray().filter(raw=>!removedWidgets.has(doc.context.lookup(raw)))
  if(kept.length!==annots.size())page.node.set(n('Annots'),doc.context.obj(kept))
 }
 if(co){
  const retained=new Set(form.acroForm.getAllFields().map(([,ref])=>String(ref))),kept=co.asArray().filter(raw=>retained.has(String(raw)))
  if(kept.length!==co.size())acro.set(n('CO'),doc.context.obj(kept))
 }
}
