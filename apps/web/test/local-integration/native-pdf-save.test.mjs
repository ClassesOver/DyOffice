import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,PDFString} from 'pdf-lib'
import {PNG} from 'pngjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createNativePdfSave} from '../../src/editors/native-pdf-save.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'

test('native PDF save maps a mixed desktop draft to one verified Web revision',async t=>{
 const f=await fileFixture(t),doc=await PDFDocument.create(),n=PDFName.of
 for(const width of [300,320,340])doc.addPage([width,240]).drawText('Saved original',{x:24,y:180,size:12})
 const target=doc.getPage(0)
 const savedMarkup=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Underline',Rect:[30,60,85,75],P:target.ref,F:4}))
 target.node.addAnnot(savedMarkup)
 const addSavedNote=contents=>{
  const ref=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[40,100,60,120],P:target.ref,Contents:PDFString.of(contents),T:PDFString.of('Original author'),F:4}))
  target.node.addAnnot(ref)
  return ref
 }
 const savedNote=addSavedNote('Update this note')
 addSavedNote('Keep this note')
 const original=Buffer.from(await doc.save()),{file}=await importFile(f,f.alice.token,original,'native.pdf')
 let revision=file.revision,calls=0
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const bridge=createNativePdfSave({
  fileId:file.fileId,path:'native.pdf',getRevision:()=>revision,getPageCount:()=>3,onSaved:async receipt=>{revision=receipt.revision},
  request:async(url,method,payload)=>{
   calls++
   const reply=await f.app.inject({url,method,payload,headers:{origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}})
   if(reply.statusCode>=400){t.diagnostic(method+' '+url.split('/').at(-1)+': '+reply.statusCode+' '+reply.body);throw Object.assign(Error('HTTP '+reply.statusCode),{status:reply.statusCode})}
   return reply.json()
  },
 })
 const draft={path:'native.pdf',annotationAuthor:'Case Reviewer',protectionDirty:false,staticFormFills:[],
  markups:[{pageIndex:0,type:'highlight',color:[1,1,0],quads:[[24,195,100,195,24,175,100,175]]}],
  drawings:[{kind:'note',pageIndex:0,at:[96,150],color:[1,1,0],contents:'Review note'}],
  formValues:[],stamps:[],textInserts:[{pageIndex:0,origin:[24,125],text:'New text',fontSize:12,color:[0,0,0]}],
  deletedPages:[1],pageOrder:[2,0,3],rotations:[{pageIndex:0,delta:-90}],metadata:{title:'Native save'},
  blankPages:[{pageIndex:3,width:612,height:792}],
  annotDeletes:[{pageIndex:0,objNum:savedMarkup.objectNumber,subtype:'underline',rect:[30,60,85,75]}],
  noteEdits:[{pageIndex:0,objNum:savedNote.objectNumber,rect:[40,100,60,120],oldContents:'Update this note',contents:'Updated saved note'}],
 }
 draft.textInserts.push({pageIndex:3,origin:[36,756],text:'Analysis report appendix',fontSize:12,color:[0,0,0]})
 const fill={id:'form-text',kind:'text',pageIndex:0,rect:[40,30,70,45],text:'Alice',fontSize:12,color:'#000000',align:'left'}
 draft.staticFormFills.push(fill)
 const image=new PNG({width:2,height:2})
 image.data.fill(255)
 draft.imageEdits=[{kind:'insertImage',pageIndex:0,rect:fill.rect,layer:'aboveText',image:PNG.sync.write(image).toString('base64')}]
 assert.equal((await bridge.save({...draft,path:'other.pdf'})).ok,false)
 assert.equal(calls,0)
 assert.equal((await bridge.save({...draft,textEdits:[{}]})).ok,false)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.equal((await bridge.save(draft)).ok,true)
 assert.notEqual(revision,file.revision)
 const bytes=await f.files.readFile(f.alice.token,file.fileId,revision),saved=await PDFDocument.load(bytes)
 assert.equal(saved.getTitle(),'Native save')
 const fills=saved.catalog.lookup(n('GenOfficeStaticFormFills'))
 assert.deepEqual(JSON.parse(fills.decodeText()),[{...fill,pageIndex:1}])
 assert.deepEqual(saved.getPages().map(page=>[page.getWidth(),page.getRotation().angle]),[[340,0],[300,270],[612,0]])
 const annots=saved.getPage(1).node.Annots().asArray().map(ref=>saved.context.lookup(ref))
 assert.ok(annots.every(dict=>String(dict.get(n('Subtype')))!=='/Underline'))
 assert.ok(annots.some(dict=>String(dict.get(n('Subtype')))==='/Highlight'&&dict.lookup(n('T')).decodeText()==='Case Reviewer'))
 assert.deepEqual(annots.filter(dict=>String(dict.get(n('Subtype')))==='/Text').map(dict=>[dict.lookup(n('Contents')).decodeText(),dict.lookup(n('T')).decodeText()]).sort(),[
  ['Keep this note','Original author'],['Review note','Case Reviewer'],['Updated saved note','Original author'],
 ])
 const leaves=await readPdfLeafObjects(bytes)
 assert.ok(leaves.some(leaf=>leaf.page===1&&leaf.type===1&&leaf.text==='New text'))
 assert.ok(leaves.some(leaf=>leaf.page===2&&leaf.type===1&&leaf.text==='Analysis report appendix'))
 assert.equal(leaves.filter(leaf=>leaf.type===1&&leaf.text==='Saved original').length,2)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 const count=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>(await connection.query('SELECT count(*)::int AS count FROM file_revisions WHERE file_id=$1',[file.fileId])).rows[0].count)
 assert.equal(count,2)
})
