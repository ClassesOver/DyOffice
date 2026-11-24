import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFString,StandardFonts} from 'pdf-lib'
import {PNG} from 'pngjs'
import {createHash} from 'node:crypto'
import {execFile as run} from 'node:child_process'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {createPdfApplyOpsJob,validatePdfApplySnapshot,parsePdfApplyOpsRequest} from '../server/src/pdf/apply-ops-job.mjs'
import {createPdfStampsJob} from '../server/src/pdf/stamps-job.mjs'
const n=PDFName.of,hash=b=>createHash('sha256').update(b).digest('hex')
const empty=()=>({fileId:'11111111-1111-4111-8111-111111111111',baseRevision:'22222222-2222-4222-8222-222222222222',generation:1,markups:[],notes:[],textInserts:[],imageEdits:[],formEdits:{},formFields:[],rotations:{},deleted:[],order:null,metadata:null})
const raw=snapshot=>JSON.stringify({version:1,action:'applyOps',snapshot})
test('saved note edits and markup deletions retain unrelated annotations in a reordered save',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([400,500])
 doc.addPage([400,500])
 const add=(subtype,text,rect)=>{
  const ref=doc.context.register(doc.context.obj({Type:'Annot',Subtype:subtype,Rect:rect,P:page.ref,Contents:PDFString.of(text),T:PDFString.of('Author'),F:4}))
  page.node.addAnnot(ref);return ref
 }
 const note=add('Text','Before',[40,100,60,120]),keep=add('Text','Same position',[40,100,60,120]),mark=add('Highlight','',[30,250,150,268])
 const bytes=Buffer.from(await doc.save()),edit={pageIndex:0,objNum:note.objectNumber,rect:[40,102,58,120],oldContents:'Before',contents:'After'}
 const snapshot={...empty(),order:[1,0],noteEdits:[edit],annotDeletes:[{pageIndex:0,objNum:mark.objectNumber,rect:[30,250,150,268],subtype:'highlight'}]}
 await assert.rejects(createPdfApplyOpsJob().execute(bytes,raw({...snapshot,noteEdits:[{...edit,oldContents:'Stale'}]})))
 const result=await createPdfApplyOpsJob().execute(bytes,raw(snapshot)),out=await PDFDocument.load(result.bytes)
 const annots=out.getPage(1).node.Annots().asArray()
 assert.deepEqual(annots.map(String),[String(note),String(keep)])
 assert.deepEqual(annots.map(ref=>out.context.lookup(ref).lookup(n('Contents')).decodeText()),['After','Same position'])
 assert.equal(out.context.lookup(note).lookup(n('T')).decodeText(),'Author')
})
test('native text rewrite changes only the chosen occurrence and rejects a wrong target atomically',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([400,500])
 page.drawText('Repeated text',{x:30,y:420,size:12})
 page.drawText('Repeated text',{x:30,y:300,size:12})
 page.drawText('Keep footer',{x:30,y:40,size:12})
 doc.addPage([400,500]).drawText('Other page',{x:30,y:300,size:12})
 const bytes=Buffer.from(await doc.save()),{readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts')
 const edit={pageIndex:0,rect:[28,297,109,313],oldText:'Repeated text',newText:'New wording',fontSize:12}
 const snapshot={...empty(),order:[1,0],textEdits:[edit]}
 await assert.rejects(createPdfApplyOpsJob().execute(bytes,raw({...snapshot,textEdits:[{...edit,rect:[28,200,109,213]}]})))
 const result=await createPdfApplyOpsJob().execute(bytes,raw(snapshot)),items=(await readPdfLeafObjects(result.bytes)).filter(item=>item.type===1&&item.page===1)
 assert.ok(items.some(item=>item.matrix[5]===420&&item.text==='Repeated text'))
 assert.ok(items.some(item=>item.matrix[5]===300&&item.text==='New wording'))
 assert.ok(items.some(item=>item.matrix[5]===40&&item.text==='Keep footer'))
 assert.equal(items.filter(item=>item.text==='Repeated text').length,1)
})
async function fixture(){const d=await PDFDocument.create(),font=await d.embedFont(StandardFonts.Helvetica);for(let i=0;i<3;i++)d.addPage([500,650]).drawText('Original page '+(i+1),{x:30,y:600,font});const form=d.getForm();for(const [name,page]of [['keep',0],['change',0],['gone',1]]){const f=form.createTextField(name);f.addToPage(d.getPage(page),{x:30,y:500,width:160,height:30});f.setText(name)}form.updateFieldAppearances(font);return Buffer.from(await d.save({useObjectStreams:false}))}
function ap(d,name){return hash(d.getForm().getTextField(name).acroField.getWidgets()[0].dict.lookup(n('AP'),PDFDict).lookup(n('N')).getContents())}
async function stampedForm(){
 const source=await PDFDocument.create()
 for(let i=1;i<=3;i++)source.addPage([500,650]).drawText('Body '+i,{x:30,y:560})
 let bytes=Buffer.from(await source.save())
 for(const operation of [{op:'set_watermark',text:'Internal draft',opacity:.3,angle:0},{op:'set_header_footer',page_number:true}]){
  bytes=(await createPdfStampsJob().execute(bytes,JSON.stringify({version:1,action:'stamps',operation}))).bytes
 }
 const doc=await PDFDocument.load(bytes),field=doc.getForm().createTextField('keep')
 field.addToPage(doc.getPage(0),{x:30,y:480,width:100,height:20});field.setText('Keep appearance')
 return Buffer.from(await doc.save())
}
test('same-page mixed editing retains managed stamp placement and untouched form appearance',async t=>{
 const bytes=await stampedForm(),before=await PDFDocument.load(bytes),{readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts')
 const snapshot={...empty(),textInserts:[{id:'T1',input:{pageIndex:0,origin:[30,410],text:'New text',fontSize:12,color:[0,0,0]}}],formFields:[{id:'F1',input:{kind:'text',name:'added',pageIndex:0,rect:[30,360,130,385],value:'已填写'}}]}
 const result=await createPdfApplyOpsJob().execute(bytes,raw(snapshot)),after=await PDFDocument.load(result.bytes)
 assert.equal(ap(after,'keep'),ap(before,'keep'));assert.equal(after.getForm().getTextField('added').getText(),'已填写')
 const stampLeaves=async input=>(await readPdfLeafObjects(input)).filter(x=>/Internal draft|[1-3] \/ 3/.test(x.text??''))
 assert.equal((await stampLeaves(bytes)).length,6);assert.deepEqual(await stampLeaves(result.bytes),await stampLeaves(bytes))
 assert.ok((await readPdfLeafObjects(result.bytes)).some(x=>x.page===0&&x.text==='New text'))
 const folder=await mkdtemp(join(tmpdir(),'pending-watermark-'));t.after(()=>rm(folder,{recursive:true,force:true}))
 const render=async (name,input)=>{
  const path=join(folder,name);await writeFile(path,input)
  // The lower half contains the watermark and footer, but none of the edits.
  return (await promisify(run)('pdftoppm',['-f','1','-l','1','-r','36','-x','0','-y','151','-W','250','-H','174',path],{encoding:'buffer',timeout:15000})).stdout
 }
 assert.deepEqual(await render('edited.pdf',result.bytes),await render('original.pdf',bytes))
})
test('mixed page deletion and reordering update managed page numbers without changing unrelated form appearance',async()=>{
 const bytes=await stampedForm(),before=await PDFDocument.load(bytes),{readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts')
 const snapshot={...empty(),deleted:[1],order:[2,0,1],rotations:{0:90}}
 const result=await createPdfApplyOpsJob().execute(bytes,raw(snapshot)),after=await PDFDocument.load(result.bytes),leaves=await readPdfLeafObjects(result.bytes)
 assert.equal(after.getPageCount(),2);assert.equal(after.getPage(1).getRotation().angle,90);assert.equal(ap(after,'keep'),ap(before,'keep'))
 for(const [page,expected]of [[0,['Body 3','1 / 2']],[1,['Body 1','2 / 2']]]){
  const text=leaves.filter(x=>x.page===page).map(x=>x.text)
  for(const item of [...expected,'Internal draft'])assert.ok(text.includes(item),JSON.stringify(text))
  assert.ok(text.every(item=>item!=='Body 2'&&!/ \/ 3$/.test(item??'')))
 }
})
test('mixed native stamp save numbers the final pages and can replace or clear just one managed layer',async()=>{
 const bytes=await fixture(),originalHash=hash(bytes),{readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts')
 const stampOperations=[{op:'set_watermark',text:'Review copy',angle:0},{op:'set_header_footer',page_number:true,start_at:7}]
 const job=createPdfApplyOpsJob()
 const saved=await job.execute(bytes,raw({...empty(),deleted:[1],order:[2,0,1],stampOperations}))
 const pageText=async (input,page)=>(await readPdfLeafObjects(input)).filter(item=>item.page===page).map(item=>item.text)
 for(const [page,expected]of [[0,['Original page 3','Review copy','7 / 2']],[1,['Original page 1','Review copy','8 / 2']]]){
  const text=await pageText(saved.bytes,page)
  for(const item of expected)assert.ok(text.includes(item),JSON.stringify(text))
 }
 const replacement=await job.execute(saved.bytes,raw({...empty(),stampOperations:[{op:'set_watermark',text:'Approved copy'}]}))
 const replaced=await pageText(replacement.bytes,0)
 assert.ok(replaced.includes('Approved copy'))
 assert.ok(!replaced.includes('Review copy'))
 const cleared=await job.execute(replacement.bytes,raw({...empty(),order:[1,0],stampOperations:[{op:'set_watermark',text:''}]}))
 const text=await pageText(cleared.bytes,0)
 assert.ok(text.includes('Original page 1')&&text.includes('7 / 2'))
 assert.ok(!text.includes('Approved copy'))
 assert.equal(hash(bytes),originalHash)
 await assert.rejects(job.execute(bytes,raw({...empty(),stampOperations:[stampOperations[0],stampOperations[0]]})),{code:'INVALID_PDF_APPLY_SNAPSHOT'})
})
test('snapshot validator rejects arbitrary writer keys getters IDs and malformed payloads',()=>{
 assert.deepEqual(validatePdfApplySnapshot(empty()),empty());assert.deepEqual(parsePdfApplyOpsRequest(raw(empty())),empty())
 const bad=[{...empty(),attachments:[]},{...empty(),generation:-1},{...empty(),rotations:{'01':90}},{...empty(),formEdits:{change:{name:'other',kind:'text',value:'x'}}},{...empty(),textInserts:[{id:'S12R',input:{}}]},{...empty(),markups:[{id:'P1',pageIndex:0,type:'highlight',color:[1,0,0],quads:[[0,0,1,1]],evil:1}]}]
 for(const input of bad)assert.throws(()=>validatePdfApplySnapshot(input),{code:'INVALID_PDF_APPLY_SNAPSHOT'})
 let read=false;const getter=empty();Object.defineProperty(getter,'metadata',{enumerable:true,get(){read=true;return null}});assert.throws(()=>validatePdfApplySnapshot(getter),{code:'INVALID_PDF_APPLY_SNAPSHOT'});assert.equal(read,false)
 assert.throws(()=>parsePdfApplyOpsRequest(JSON.stringify({version:1,action:'applyOps',snapshot:empty(),request:{}})),{code:'INVALID_REQUEST'})
})
test('one native snapshot writes mixed forms notes markup rotations deletion order metadata and preserves old AP/content',async()=>{
 const original=await fixture(),before=await PDFDocument.load(original),snapshot={...empty(),markups:[{id:'Pmark',pageIndex:0,type:'highlight',color:[1,1,0],quads:[[30,615,140,615,30,598,140,598]]}],notes:[{id:'Pnote',input:{kind:'note',pageIndex:0,color:[1,0.9,0.3],at:[200,400],contents:'Comment'}}],formEdits:{change:{name:'change',kind:'text',value:'已更新'}},formFields:[{id:'Fnew',input:{name:'newChoice',kind:'choice',pageIndex:0,rect:[230,450,400,480],options:['中文','日本語'],value:'中文'}}],rotations:{0:90},deleted:[1],order:[2,0,1],metadata:{title:'Mixed atomic'}}
 const result=await createPdfApplyOpsJob().execute(original,raw(snapshot)),out=await PDFDocument.load(result.bytes)
 assert.equal(hash(original),result.inputSha256);assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length);assert.equal(out.getPageCount(),2);assert.equal(out.getTitle(),'Mixed atomic');assert.equal(out.getPage(1).getRotation().angle,90);assert.equal(ap(out,'keep'),ap(before,'keep'));assert.equal(out.getForm().getTextField('change').getText(),'已更新');assert.deepEqual(out.getForm().getDropdown('newChoice').getSelected(),['中文']);assert.equal(out.getForm().getFieldMaybe('gone'),undefined)
 const annots=out.getPage(1).node.Annots().asArray().map(ref=>out.context.lookup(ref));assert.ok(annots.some(a=>String(a.get(n('Subtype')))==='/Highlight'));assert.ok(annots.some(a=>String(a.get(n('Subtype')))==='/Text'&&a.lookup(n('Contents')).decodeText()==='Comment'))
 const {readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts');const leaves=await readPdfLeafObjects(result.bytes);assert.ok(leaves.some(x=>x.page===0&&x.text==='Original page 3'));assert.ok(leaves.some(x=>x.page===1&&x.text==='Original page 1'));assert.ok(!leaves.some(x=>x.text==='Original page 2'))
})
test('strict native snapshot verifies actual pages field kinds values and protection before output',async()=>{
 const original=await fixture()
 for(const snapshot of [{...empty(),deleted:[0,1,2]},{...empty(),formEdits:{missing:{name:'missing',kind:'text',value:'x'}}},{...empty(),formEdits:{change:{name:'change',kind:'checkbox',checked:true}}},{...empty(),formFields:[{id:'F1',input:{name:'bad',kind:'text',pageIndex:0,rect:[-100,-100,20,20]}}]},{...empty(),notes:[{id:'P1',input:{kind:'note',pageIndex:4,color:[1,1,0],at:[20,20],contents:'Bad'}}]}])await assert.rejects(createPdfApplyOpsJob().execute(original,raw(snapshot)))
 for(const protection of ['xfa','signature']){const d=await PDFDocument.load(original);if(protection==='xfa')d.getForm().acroForm.dict.set(n('XFA'),d.context.stream('xfa'));else d.catalog.set(n('Perms'),d.context.obj({}));await assert.rejects(createPdfApplyOpsJob().execute(Buffer.from(await d.save({updateFieldAppearances:false})),raw({...empty(),metadata:{title:'refused'}})),{code:protection==='xfa'?'PDF_EDIT_UNSUPPORTED_STRUCTURE':'SIGNATURE_EDIT_REFUSED'})}
 const controller=new AbortController();controller.abort();await assert.rejects(createPdfApplyOpsJob().execute(original,raw(empty()),controller.signal),{code:'ABORTED'})
})
test('pending native text and image payloads survive mixed snapshot writing without losing existing page objects',async()=>{
 const d=await PDFDocument.create();d.addPage([400,500]).drawText('Keep content',{x:30,y:450});const original=Buffer.from(await d.save()),{PNG}=await import('pngjs'),png=new PNG({width:2,height:2});png.data.fill(255)
 const snapshot={...empty(),textInserts:[{id:'T1',input:{pageIndex:0,origin:[40,350],text:'Added content',fontSize:14,color:[0,0,0]}}],imageEdits:[{id:'I1',input:{kind:'insertImage',pageIndex:0,image:PNG.sync.write(png).toString('base64'),rect:[100,200,120,220],layer:'aboveText'}}],metadata:{subject:'Text and image'}}
 const result=await createPdfApplyOpsJob().execute(original,raw(snapshot)),{readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts'),leaves=await readPdfLeafObjects(result.bytes)
 assert.ok(leaves.some(x=>x.text==='Keep content'));assert.ok(leaves.some(x=>x.text==='Added content'));assert.equal(leaves.filter(x=>x.type===3).length,1)
})


test('saved note thread and untouched fields survive text content rewrite with page reorder',async()=>{
 const source=await PDFDocument.load(await fixture()),page=source.getPage(0),note=source.context.register(source.context.obj({Type:'Annot',Subtype:'Text',Rect:[210,300,230,320],P:page.ref,Contents:source.context.obj('Existing note'),T:source.context.obj('Original author'),F:4})),reply=source.context.register(source.context.obj({Type:'Annot',Subtype:'Text',Rect:[210,300,230,320],P:page.ref,Contents:source.context.obj('Existing reply'),IRT:note,RT:'R',F:4}));page.node.Annots().push(note);page.node.Annots().push(reply)
 const original=Buffer.from(await source.save({updateFieldAppearances:false})),old=await PDFDocument.load(original),s={...empty(),textInserts:[{id:'T1',input:{pageIndex:0,origin:[30,350],text:'New text',fontSize:12,color:[20,30,40]}}],order:[2,1,0],metadata:{subject:'Preserved'}}
 const result=await createPdfApplyOpsJob().execute(original,raw(s)),out=await PDFDocument.load(result.bytes),notes=out.getPage(2).node.Annots().asArray().map(ref=>({ref,dict:out.context.lookup(ref)})).filter(({dict})=>String(dict.get(n('Subtype')))==='/Text')
 assert.equal(ap(out,'keep'),ap(old,'keep'));assert.equal(notes.length,2);const root=notes.find(({dict})=>dict.lookup(n('Contents')).decodeText()==='Existing note'),child=notes.find(({dict})=>dict.lookup(n('Contents')).decodeText()==='Existing reply');assert.equal(root.dict.lookup(n('T')).decodeText(),'Original author');assert.equal(String(child.dict.get(n('IRT'))),String(root.ref))
})

test('native existing image transform and delete preserve unrelated original content',async()=>{
 const {PNG}=await import('pngjs'),png=new PNG({width:2,height:2});png.data.fill(255);const d=await PDFDocument.create(),p=d.addPage([400,500]),image=await d.embedPng(PNG.sync.write(png));p.drawText('Protected',{x:30,y:450});p.drawImage(image,{x:100,y:200,width:20,height:20});const original=Buffer.from(await d.save())
 for(const operation of [{kind:'transformImage',pageIndex:0,oldRect:[100,200,120,220],rect:[150,200,190,240]},{kind:'deleteImage',pageIndex:0,oldRect:[100,200,120,220]}]){
  const result=await createPdfApplyOpsJob().execute(original,raw({...empty(),imageEdits:[{id:'I1',input:operation}],metadata:{title:'Existing image'}})),{readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts'),leaves=await readPdfLeafObjects(result.bytes)
  assert.ok(leaves.some(x=>x.text==='Protected'));assert.equal(leaves.filter(x=>x.type===3).length,operation.kind==='deleteImage'?0:1)
 }
})


test('field authoring cannot append to a saved read-only radio group or mutate its selected state',async()=>{
 const d=await PDFDocument.load(await fixture()),group=d.getForm().createRadioGroup('lockedRadio');group.addOptionToPage('old',d.getPage(0),{x:250,y:500,width:20,height:20});group.select('old');group.enableReadOnly();const original=Buffer.from(await d.save({updateFieldAppearances:false}))
 await assert.rejects(createPdfApplyOpsJob().execute(original,raw({...empty(),formFields:[{id:'Fnew',input:{name:'lockedRadio',kind:'radio',pageIndex:0,rect:[280,500,300,520],exportValue:'new',checked:true}}]})),{code:'INVALID_PDF_APPLY_SNAPSHOT'})
 assert.equal((await PDFDocument.load(original)).getForm().getRadioGroup('lockedRadio').getSelected(),'old')
})


test('mixed snapshot retains authored text field font size and both date actions',async()=>{
 const snapshot={...empty(),formFields:[{id:'Fdate',input:{name:'date',kind:'text',pageIndex:0,rect:[230,450,400,480],value:'2026-11-20',fontSize:16,dateFormat:'yyyy-mm-dd'}}],metadata:{title:'Date field'}}
 const result=await createPdfApplyOpsJob().execute(await fixture(),raw(snapshot)),out=await PDFDocument.load(result.bytes),field=out.getForm().getTextField('date')
 assert.match(field.acroField.getDefaultAppearance(),/16\s+Tf/)
 for(const dict of [field.acroField.dict,...field.acroField.getWidgets().map(w=>w.dict)]){
  const actions=dict.lookup(n('AA'),PDFDict)
  for(const [key,script]of [['F','AFDate_FormatEx("yyyy-mm-dd");'],['K','AFDate_KeystrokeEx("yyyy-mm-dd");']]){const action=actions.lookup(n(key),PDFDict);assert.equal(String(action.get(n('S'))),'/JavaScript');assert.equal(action.lookup(n('JS')).decodeText(),script)}
 }
})


test('deleting the selected radio option clears selection while retaining surviving options',async()=>{
 const d=await PDFDocument.create();d.addPage([400,500]);d.addPage([400,500]);const group=d.getForm().createRadioGroup('r');group.addOptionToPage('gone',d.getPage(0),{x:30,y:40,width:20,height:20});group.addOptionToPage('keep',d.getPage(1),{x:30,y:40,width:20,height:20});const checkbox=d.getForm().createCheckBox('check');for(const page of d.getPages())checkbox.addToPage(page,{x:80,y:40,width:20,height:20})
 const result=await createPdfApplyOpsJob().execute(Buffer.from(await d.save()),raw({...empty(),formEdits:{r:{name:'r',kind:'radio',value:'gone'},check:{name:'check',kind:'checkbox',checked:true}},deleted:[0]})),out=await PDFDocument.load(result.bytes),radio=out.getForm().getRadioGroup('r')
 assert.deepEqual(radio.getOptions(),['keep']);assert.equal(radio.getSelected(),undefined);assert.equal(out.getForm().getCheckBox('check').isChecked(),true)
})
test('empty note author uses the native default author',async()=>{
 const result=await createPdfApplyOpsJob().execute(await fixture(),raw({...empty(),notes:[{id:'P1',input:{kind:'note',pageIndex:0,color:[1,1,0],at:[200,300],contents:'Default author',author:''}}]})),out=await PDFDocument.load(result.bytes),note=out.getPage(0).node.Annots().asArray().map(ref=>out.context.lookup(ref)).find(dict=>String(dict.get(n('Subtype')))==='/Text')
 assert.equal(note.lookup(n('T')).decodeText(),'AI Assistant')
})


test('duplicate saved radio export labels follow native selection of the last matching widget',async()=>{
 const d=await PDFDocument.create();d.addPage([400,500]);d.addPage([400,500]);const group=d.getForm().createRadioGroup('r');group.addOptionToPage('first',d.getPage(0),{x:30,y:40,width:20,height:20});group.addOptionToPage('second',d.getPage(1),{x:30,y:40,width:20,height:20});group.acroField.dict.set(n('Opt'),d.context.obj([PDFString.of('same'),PDFString.of('same')]))
 const result=await createPdfApplyOpsJob().execute(Buffer.from(await d.save()),raw({...empty(),formEdits:{r:{name:'r',kind:'radio',value:'same'}},deleted:[0]})),out=await PDFDocument.load(result.bytes)
 assert.equal(out.getForm().getRadioGroup('r').getSelected(),'same');assert.deepEqual(out.getForm().getRadioGroup('r').getOptions(),['same'])
})


test('positioned multiline inserts preserve originals when PDFium synthesizes a trailing gap space',async()=>{
 const d=await PDFDocument.create();for(let i=0;i<2;i++){const p=d.addPage([500,600]);p.drawText('Original page '+(i+1),{x:40,y:500,size:12});if(i)p.setRotation({type:'degrees',angle:90})}
 const original=Buffer.from(await d.save()),snapshot={...empty(),textInserts:[{id:'Tgap',input:{pageIndex:0,origin:[70,489],text:'WWWW iiiii\nHello',fontSize:16,color:[17,51,85],lineLeading:19.2,rotate:0}}]}
 const result=await createPdfApplyOpsJob().execute(original,raw(snapshot)),{readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts'),before=await readPdfLeafObjects(original),after=await readPdfLeafObjects(result.bytes),old=before.find(x=>x.text==='Original page 1'),kept=after.find(x=>x.text.startsWith('Original page 1'))
 assert.equal(old.text,'Original page 1');assert.equal(kept.text,'Original page 1 ');for(const key of ['font','bounds','matrix','fill','stroke','size','mode'])assert.deepEqual(kept[key],old[key]);assert.ok(after.some(x=>x.text==='Hello'))
 const verified=await readPdfLeafObjects(result.bytes,false,{normalizeSyntheticTextSuffix:true});assert.equal(verified.find(x=>x.text.startsWith('Original page 1')).text,'Original page 1');assert.deepEqual(await readPdfLeafObjects(original,false,{normalizeSyntheticTextSuffix:true}),before)
})


test('verification text reading leaves ordinary content and extracted whitespace exactly unchanged',async()=>{
 const d=await PDFDocument.create(),p=d.addPage([500,600]);for(const [i,text]of ['Authored  ','Inner  spaces','Different content',' Leading and trailing '].entries())p.drawText(text,{x:40,y:500-i*60,size:12})
 const bytes=Buffer.from(await d.save()),{readPdfLeafObjects}=await import('../../pdf/src/main/text-edit.ts'),ordinary=await readPdfLeafObjects(bytes),verified=await readPdfLeafObjects(bytes,false,{normalizeSyntheticTextSuffix:true})
 assert.deepEqual(verified,ordinary);assert.notEqual(verified[0].text,verified[2].text)
})

test('mixed PDF save preserves drawing annotations through rotation and reordered pages',async()=>{
 const doc=await PDFDocument.create()
 doc.addPage([400,500]).drawText('Original content')
 doc.addPage([400,500])
 const before=Buffer.from(await doc.save())
 const paint={pageIndex:0,color:[.2,.4,.6],width:2}
 const signatureImage=PNG.sync.write({width:2,height:2,data:Buffer.from([0,0,0,255,0,0,0,0,0,0,0,0,0,0,0,255])}).toString('base64')
 const drawings=[
  {...paint,kind:'ink',paths:[Array.from({length:900},(_,index)=>[40+index/10,390-index/10]).flat()]},
  {...paint,kind:'rect',rect:[40,160,100,200]},
  {...paint,kind:'ellipse',rect:[120,160,180,200]},
  {...paint,kind:'arrow',from:[200,220],to:[240,250]},
  {...paint,kind:'polygon',vertices:[[100,60],[150,70],[125,90]]},
  {kind:'link',pageIndex:0,rect:[10,10,50,30],destPage:2},
  {...paint,kind:'measure',from:[70,120],to:[150,120],label:'2.00 厘米'},
  {kind:'link',pageIndex:0,rect:[200,10,260,30],url:'https://example.test/a)b?q=张'},
  {kind:'image',pageIndex:0,rect:[295,62,345,94],image:signatureImage,formFieldName:'approval'},
 ]
 const formFields=[{id:'F1',input:{kind:'signature',name:'approval',pageIndex:0,rect:[290,60,350,96]}}]
 const snapshot={...empty(),drawings,formFields,order:[1,0],rotations:{0:90}}
 const {bytes}=await createPdfApplyOpsJob().execute(before,raw(snapshot)),saved=await PDFDocument.load(bytes)
 const annots=saved.getPage(1).node.Annots().asArray().map(ref=>saved.context.lookup(ref,PDFDict))
  .filter(annot=>String(annot.get(n('Subtype')))!=='/Widget')
 assert.equal(saved.getPage(1).getRotation().angle,90)
 assert.deepEqual(annots.map(annot=>String(annot.get(n('Subtype')))),['/Ink','/Square','/Circle','/Line','/Polygon','/Link','/Line','/Link','/Stamp'])
 assert.deepEqual(annots[0].lookup(n('InkList')).lookup(0).asArray().map(value=>value.asNumber()),drawings[0].paths[0])
 assert.ok(annots.slice(0,5).every(annot=>annot.lookup(n('AP'),PDFDict).has(n('N'))))
 assert.equal(annots[5].lookup(n('Dest')).get(0),saved.getPage(0).ref)
 assert.equal(annots[6].lookup(n('Contents')).decodeText(),'2.00 厘米')
 const measureFont=annots[6].lookup(n('AP')).lookup(n('N')).dict.lookup(n('Resources')).lookup(n('Font')).lookup(n('F1'))
 assert.equal(String(measureFont.get(n('Subtype'))),'/Type0')
 assert.equal(new TextDecoder().decode(annots[7].lookup(n('A')).lookup(n('URI')).asBytes()),drawings[7].url)
 assert.equal(annots[8].lookup(n('GenOfficeFormField')).decodeText(),'approval')
 assert.ok(annots[8].lookup(n('AP'),PDFDict).has(n('N')))
 assert.equal(saved.getForm().getSignature('approval').acroField.dict.has(n('V')),false)
 await assert.rejects(createPdfApplyOpsJob().execute(before,raw({...snapshot,drawings:[{kind:'link',pageIndex:0,rect:[10,10,50,30],url:'javascript:alert(1)'}]})),{code:'INVALID_PDF_APPLY_SNAPSHOT'})
})

test('mixed PDF save persists hierarchical bookmarks and edits the exact existing widgets',async()=>{
 const doc=await PDFDocument.create()
 const page=doc.addPage([400,500]),second=doc.addPage([400,500])
 const form=doc.getForm()
 const keep=form.createTextField('keep'),move=form.createTextField('move'),remove=form.createTextField('remove')
 keep.addToPage(page,{x:20,y:70,width:100,height:20})
 move.addToPage(page,{x:20,y:120,width:100,height:20})
 remove.addToPage(page,{x:20,y:150,width:100,height:20})
 move.setText('Keep value')
 const widgetId=field=>field.acroField.Kids().get(0).objectNumber+'R'
 const target=[35,170,185,200]
 const formWidgetEdits=[{widgetId:widgetId(move),fieldName:'move',rect:target,required:true},{widgetId:widgetId(remove),fieldName:'remove',remove:true}]
 const outline=[{title:'章节',pageIndex:0,top:320,children:[{title:'Details',pageIndex:1}]}]
 const before=Buffer.from(await doc.save())
 const snapshot={...empty(),outline,formWidgetEdits,order:[1,0]}
 await assert.rejects(createPdfApplyOpsJob().execute(before,raw({...snapshot,formWidgetEdits:[{...formWidgetEdits[0],widgetId:widgetId(keep)}]})),{code:'INVALID_PDF_APPLY_SNAPSHOT'})
 const {bytes}=await createPdfApplyOpsJob().execute(before,raw(snapshot)),saved=await PDFDocument.load(bytes)
 const chapter=saved.catalog.lookup(n('Outlines'),PDFDict).lookup(n('First'),PDFDict)
 const child=chapter.lookup(n('First'),PDFDict)
 assert.equal(chapter.lookup(n('Title')).decodeText(),'章节')
 assert.equal(chapter.lookup(n('Dest')).get(0),saved.getPage(1).ref)
 assert.equal(chapter.lookup(n('Dest')).lookup(3).asNumber(),320)
 assert.equal(child.lookup(n('Title')).decodeText(),'Details')
 assert.equal(child.lookup(n('Dest')).get(0),saved.getPage(0).ref)
 const updated=saved.getForm().getTextField('move'),bounds=updated.acroField.getWidgets()[0].getRectangle()
 assert.equal(updated.isRequired(),true)
 assert.equal(updated.getText(),'Keep value')
 assert.deepEqual([bounds.x,bounds.y,bounds.x+bounds.width,bounds.y+bounds.height],target)
 assert.equal(saved.getForm().getFieldMaybe('remove'),undefined)
 assert.equal(ap(saved,'keep'),ap(await PDFDocument.load(before),'keep'))
})

test('PDF widget removal keeps the surviving radio option and clears the removed selection',async()=>{
 const doc=await PDFDocument.create()
 const page=doc.addPage([400,500]),radio=doc.getForm().createRadioGroup('choice')
 radio.addOptionToPage('remove option',page,{x:20,y:150,width:20,height:20})
 radio.addOptionToPage('keep option',page,{x:20,y:120,width:20,height:20})
 radio.select('remove option')
 const widget=radio.acroField.Kids().get(0)
 const input=Buffer.from(await doc.save())
 const formWidgetEdits=[{widgetId:widget.objectNumber+'R',fieldName:'choice',remove:true}]
 const {bytes}=await createPdfApplyOpsJob().execute(input,raw({...empty(),formWidgetEdits}))
 const saved=await PDFDocument.load(bytes),actual=saved.getForm().getRadioGroup('choice')
 assert.deepEqual(actual.getOptions(),['keep option'])
 assert.equal(actual.getSelected(),undefined)
 assert.equal(saved.getPage(0).node.Annots().asArray().length,1)
})
