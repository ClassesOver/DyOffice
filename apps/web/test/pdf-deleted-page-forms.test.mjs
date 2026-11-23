import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFString,StandardFonts} from 'pdf-lib'
import {cleanupDeletedPageForms} from '../server/src/pdf/deleted-page-forms.mjs'
const n=PDFName.of,hash=b=>createHash('sha256').update(b).digest('hex')
async function fixture(){const d=await PDFDocument.create();d.addPage([300,400]);d.addPage([300,400]);d.addPage([300,400]);return d}
function text(d,name,page){const f=d.getForm().createTextField(name);f.addToPage(d.getPage(page),{x:20,y:20,width:100,height:20});f.setText(name);return f}
async function reload(d){return PDFDocument.load(await d.save({useObjectStreams:false,updateFieldAppearances:false}))}
function ref(d,page){return String(d.getPage(page).ref)}
function ap(d,w){const a=w.dict.lookup(n('AP'),PDFDict).lookup(n('N'));return a instanceof PDFDict?Object.fromEntries(a.entries().map(([k,r])=>[String(k),hash(d.context.lookup(r).getContents())])):hash(a.getContents())}
const code={code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'}
test('removes a deleted-page text leaf and its page annotation while keeping other field values and AP bytes',async()=>{
 let d=await fixture();text(d,'gone',0);text(d,'keep',1);d.getForm().updateFieldAppearances(await d.embedFont(StandardFonts.Helvetica));d=await reload(d)
 const keep=d.getForm().getTextField('keep'),before=ap(d,keep.acroField.getWidgets()[0]),beforeParent=keep.acroField.dict.get(n('Parent'))
 cleanupDeletedPageForms(d,[ref(d,0)])
 assert.equal(d.getForm().getFieldMaybe('gone'),undefined);assert.equal(d.getPage(0).node.Annots().size(),0);assert.equal(d.getForm().getTextField('keep').getText(),'keep');assert.deepEqual(ap(d,keep.acroField.getWidgets()[0]),before);assert.equal(keep.acroField.dict.get(n('Parent')),beforeParent)
 d.removePage(0);const out=await reload(d);assert.equal(out.getPageCount(),2);assert.deepEqual(out.getForm().getFields().map(f=>f.getName()),['keep'])
})
test('prunes nested empty parents but preserves sibling parent refs and untouched children',async()=>{
 const d=await fixture();text(d,'group.gone',0);text(d,'group.keep',1);text(d,'empty.nested.only',0);text(d,'unrelated',2)
 const kept=d.getForm().getTextField('group.keep'),parent=kept.acroField.dict.get(n('Parent')),parentDict=d.context.lookup(parent),rootCount=d.getForm().acroForm.Fields().size()
 cleanupDeletedPageForms(d,[ref(d,0)])
 assert.deepEqual(d.getForm().getFields().map(f=>f.getName()),['group.keep','unrelated']);assert.equal(kept.acroField.dict.get(n('Parent')),parent);assert.equal(parentDict.lookup(n('Kids'),PDFArray).size(),1);assert.equal(d.getForm().acroForm.Fields().size(),rootCount-1)
 const out=await reload(d);assert.equal(out.getForm().getTextField('group.keep').getText(),'group.keep')
})
test('cross-page radio retains options values flags and appearance bytes when the selected widget survives',async()=>{
 let d=await fixture();const r=d.getForm().createRadioGroup('radio');r.addOptionToPage('gone',d.getPage(0),{x:20,y:20,width:20,height:20});r.addOptionToPage('kept',d.getPage(1),{x:20,y:20,width:20,height:20});r.select('kept');r.enableRequired();d=await reload(d)
 const group=d.getForm().getRadioGroup('radio'),widget=group.acroField.getWidgets()[1],appearance=ap(d,widget),parent=widget.dict.get(n('Parent')),flags=group.acroField.getFlags()
 cleanupDeletedPageForms(d,[ref(d,0)])
 assert.deepEqual(group.getOptions(),['kept']);assert.equal(group.getSelected(),'kept');assert.equal(group.acroField.getFlags(),flags);assert.equal(group.acroField.getWidgets().length,1);assert.deepEqual(ap(d,widget),appearance);assert.equal(widget.dict.get(n('Parent')),parent);assert.equal(String(widget.getAppearanceState()),'/1')
 const out=await reload(d);assert.equal(out.getForm().getRadioGroup('radio').getSelected(),'kept')
})
test('cross-page radio clears V and AS when only its selected widget was deleted',async()=>{
 let d=await fixture();const r=d.getForm().createRadioGroup('radio');r.addOptionToPage('selected',d.getPage(0),{x:20,y:20,width:20,height:20});r.addOptionToPage('kept',d.getPage(1),{x:20,y:20,width:20,height:20});r.select('selected');r.acroField.dict.set(n('DV'),r.acroField.dict.get(n('V')));d=await reload(d)
 const group=d.getForm().getRadioGroup('radio'),widget=group.acroField.getWidgets()[1],appearance=ap(d,widget)
 cleanupDeletedPageForms(d,[ref(d,0)])
 assert.deepEqual(group.getOptions(),['kept']);assert.equal(group.getSelected(),undefined);assert.equal(String(group.acroField.dict.lookup(n('V'))),'/Off');assert.equal(String(group.acroField.dict.lookup(n('DV'))),'/Off');assert.equal(String(widget.getAppearanceState()),'/Off');assert.deepEqual(ap(d,widget),appearance)
})
test('locates missing-P widgets through page Annots and preserves genuine widgetless data fields',async()=>{
 const d=await fixture(),gone=text(d,'gone',0),keep=text(d,'keep',1),data=d.getForm().createTextField('data');data.setText('not a widget')
 for(const f of [gone,keep])f.acroField.getWidgets()[0].dict.delete(n('P'))
 cleanupDeletedPageForms(d,[ref(d,0)])
 assert.equal(d.getForm().getFieldMaybe('gone'),undefined);assert.equal(d.getForm().getTextField('keep').getText(),'keep');assert.equal(d.getForm().getTextField('data').getText(),'not a widget')
})
test('rejects ambiguous widget pages malformed parent trees and inconsistent radio metadata before mutation',async()=>{
 for(const mode of ['twoPages','wrongP','wrongParent','duplicateChild','orphan','unknownPage','radioOpt']){
  const d=await fixture(),gone=text(d,'firstGone',0),kept=text(d,'keep',1),widget=kept.acroField.getWidgets()[0],widgetRef=kept.acroField.Kids().get(0)
  if(mode==='twoPages')d.getPage(2).node.addAnnot(widgetRef)
  if(mode==='wrongP')widget.dict.set(n('P'),d.getPage(0).ref)
  if(mode==='wrongParent')widget.dict.set(n('Parent'),gone.ref)
  if(mode==='duplicateChild')kept.acroField.Kids().push(widgetRef)
  if(mode==='orphan'){kept.acroField.dict.set(n('Kids'),d.context.obj([]))}
  if(mode==='radioOpt'){const r=d.getForm().createRadioGroup('r');r.addOptionToPage('a',d.getPage(0),{x:20,y:50,width:20,height:20});r.addOptionToPage('b',d.getPage(1),{x:20,y:50,width:20,height:20});r.acroField.dict.set(n('Opt'),d.context.obj([PDFString.of('bad')]))}
  const original=String(d.getForm().acroForm.dict),annots=d.getPage(0).node.Annots().toString()
  assert.throws(()=>cleanupDeletedPageForms(d,[mode==='unknownPage'?'99999 0 R':ref(d,0)]),code,mode)
  assert.equal(String(d.getForm().acroForm.dict),original,mode);assert.equal(d.getPage(0).node.Annots().toString(),annots,mode);assert.ok(d.getForm().getFieldMaybe('firstGone'))
 }
})
test('no deleted pages is a no-op without creating AcroForm and duplicate or invalid ref input rejects',async()=>{
 const d=await fixture();cleanupDeletedPageForms(d,[]);assert.equal(d.catalog.has(n('AcroForm')),false)
 for(const refs of [[ref(d,0),ref(d,0)],[0],['bad']])assert.throws(()=>cleanupDeletedPageForms(d,refs),code)
})

test('merged field/widgets are removed without leaving field roots or annotations',async()=>{
 const d=await fixture(),p=d.getPage(0),dict=d.context.obj({Type:'Annot',Subtype:'Widget',FT:'Tx',T:PDFString.of('merged'),V:PDFString.of('value'),Rect:[10,10,100,30],P:p.ref}),ref=d.context.register(dict)
 d.getForm().acroForm.addField(ref);p.node.addAnnot(ref);text(d,'kept',1)
 cleanupDeletedPageForms(d,[String(p.ref)])
 assert.equal(d.getForm().getFieldMaybe('merged'),undefined);assert.equal(p.node.Annots().size(),0);assert.equal(d.getForm().getTextField('kept').getText(),'kept')
})
test('multi-widget checkbox keeps its surviving checked widget and appearance',async()=>{
 const d=await fixture(),c=d.getForm().createCheckBox('check');for(const p of d.getPages().slice(0,2))c.addToPage(p,{x:20,y:20,width:20,height:20});c.check()
 const keep=c.acroField.getWidgets()[1],appearance=ap(d,keep)
 cleanupDeletedPageForms(d,[ref(d,0)])
 assert.equal(c.isChecked(),true);assert.equal(c.acroField.getWidgets().length,1);assert.equal(String(keep.getAppearanceState()),'/Yes');assert.deepEqual(ap(d,keep),appearance)
})
test('radio cleanup retains original appearance names after removing the middle option',async()=>{
 const d=await fixture(),r=d.getForm().createRadioGroup('radio')
 for(const [i,name]of ['one','two','three'].entries())r.addOptionToPage(name,d.getPage(i),{x:20,y:20,width:20,height:20})
 r.select('three');const kept=r.acroField.getWidgets()[2],before=ap(d,kept)
 cleanupDeletedPageForms(d,[ref(d,1)])
 assert.deepEqual(r.getOptions(),['one','three']);assert.equal(r.getSelected(),'three');assert.equal(String(kept.getAppearanceState()),'/2');assert.deepEqual(ap(d,kept),before)
 const out=await reload(d);assert.equal(out.getForm().getRadioGroup('radio').getSelected(),'three')
})
test('prunes calculation order references only for removed fields',async()=>{
 const d=await fixture(),a=text(d,'gone',0),b=text(d,'keep',1);d.getForm().acroForm.dict.set(n('CO'),d.context.obj([a.ref,b.ref]))
 cleanupDeletedPageForms(d,[ref(d,0)])
 const co=d.getForm().acroForm.dict.lookup(n('CO'),PDFArray);assert.equal(co.size(),1);assert.equal(String(co.get(0)),String(b.ref))
})
test('rejects field dictionaries referenced twice under distinct indirect refs before deleting anything',async()=>{
 const d=await fixture(),a=text(d,'gone',0),b=text(d,'keep',1),alias=d.context.register(b.acroField.dict)
 d.getForm().acroForm.Fields().push(alias)
 assert.throws(()=>cleanupDeletedPageForms(d,[ref(d,0)]),code);assert.ok(d.getForm().getFieldMaybe('gone'))
})

test('rejects aliased widgetless fields and duplicate fully-qualified field names',async()=>{
 for(const alias of [true,false]){
  const d=await fixture();text(d,'gone',0);const data=d.getForm().createTextField('data');data.setText('keep')
  const extra=alias?data.acroField.dict:d.context.obj({FT:'Tx',T:PDFString.of('data'),V:PDFString.of('other')})
  d.getForm().acroForm.Fields().push(d.context.register(extra))
  assert.throws(()=>cleanupDeletedPageForms(d,[ref(d,0)]),code);assert.ok(d.getForm().getFieldMaybe('gone'))
 }
})

test('rejects radio appearance states that map one on-value to conflicting export labels',async()=>{
 const d=await fixture(),r=d.getForm().createRadioGroup('radio')
 r.addOptionToPage('one',d.getPage(0),{x:20,y:20,width:20,height:20});r.addOptionToPage('two',d.getPage(1),{x:20,y:20,width:20,height:20})
 const second=r.acroField.getWidgets()[1],normal=second.dict.lookup(n('AP'),PDFDict).lookup(n('N'),PDFDict)
 normal.set(n('0'),normal.get(n('1')));normal.delete(n('1'));r.acroField.setValue(n('0'))
 assert.throws(()=>cleanupDeletedPageForms(d,[ref(d,0)]),code);assert.equal(r.acroField.getWidgets().length,2)
})

test('copy-on-write protects another radio group sharing an indirect Opt array',async()=>{
 let d=await fixture();const a=d.getForm().createRadioGroup('a'),b=d.getForm().createRadioGroup('b')
 for(const [group,pages]of [[a,[0,1]],[b,[1,2]]]){for(const [i,name]of ['one','two'].entries())group.addOptionToPage(name,d.getPage(pages[i]),{x:20,y:20,width:20,height:20});group.select('two')}
 const optRef=d.context.register(a.acroField.dict.lookup(n('Opt'),PDFArray));a.acroField.dict.set(n('Opt'),optRef);b.acroField.dict.set(n('Opt'),optRef);d=await reload(d)
 const first=d.getForm().getRadioGroup('a'),other=d.getForm().getRadioGroup('b'),originalOpt=other.acroField.dict.get(n('Opt')),widgets=other.acroField.getWidgets(),appearances=widgets.map(w=>ap(d,w))
 cleanupDeletedPageForms(d,[ref(d,0)])
 assert.deepEqual(first.getOptions(),['two']);assert.equal(first.getSelected(),'two');assert.deepEqual(other.getOptions(),['one','two']);assert.equal(other.getSelected(),'two');assert.equal(other.acroField.dict.get(n('Opt')),originalOpt);assert.deepEqual(widgets.map(w=>ap(d,w)),appearances)
 const out=await reload(d);assert.deepEqual(out.getForm().getRadioGroup('b').getOptions(),['one','two']);assert.equal(out.getForm().getRadioGroup('b').getSelected(),'two')
})

test('detaches mutable parent Kids Fields Annots and CO arrays from other dictionary owners',async()=>{
 const d=await fixture(),gone=text(d,'group.gone',0),keep=text(d,'group.keep',1),parent=d.context.lookup(keep.acroField.dict.get(n('Parent'))),form=d.getForm().acroForm
 const arrays=[parent.lookup(n('Kids'),PDFArray),form.Fields(),d.getPage(0).node.Annots(),d.context.obj([gone.ref,keep.ref])],holder=d.context.obj({})
 form.dict.set(n('CO'),arrays[3])
 for(const [i,array]of arrays.entries())holder.set(n('Shared'+i),d.context.register(array))
 const before=arrays.map(array=>array.toString());d.catalog.set(n('TestSharedArrays'),holder)
 cleanupDeletedPageForms(d,[ref(d,0)])
 assert.equal(d.getForm().getFieldMaybe('group.gone'),undefined);assert.equal(d.getForm().getTextField('group.keep').getText(),'group.keep')
 for(const [i,array]of arrays.entries())assert.equal(holder.lookup(n('Shared'+i),PDFArray).toString(),before[i])
 assert.equal(form.dict.lookup(n('CO'),PDFArray).size(),1);assert.equal(parent.lookup(n('Kids'),PDFArray).size(),1)
})
test('shared Kids ownership between distinct fields is rejected before mutation',async()=>{
 const d=await fixture(),a=text(d,'a',0),b=text(d,'b',1)
 b.acroField.dict.set(n('Kids'),d.context.register(a.acroField.Kids()))
 const kids=a.acroField.Kids().toString(),annots=d.getPage(0).node.Annots().toString()
 assert.throws(()=>cleanupDeletedPageForms(d,[ref(d,0)]),code);assert.equal(a.acroField.Kids().toString(),kids);assert.equal(d.getPage(0).node.Annots().toString(),annots)
})
