import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {execFileSync,spawn} from 'node:child_process'
import {crc32} from 'node:zlib'
import JSZip from 'jszip'
import { PNG } from 'pngjs'


const bytes=()=>readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))

test('aborting a pending native PPTX open closes the child before returning a handle', async () => {
 const controller=new AbortController()
 const pending=openIsolatedPptxSession({fileId:'aborted-open',revision:'r1',bytes:await bytes()},
  {timeoutMs:60000,unsafeTestOnly:true,signal:controller.signal})
 controller.abort()
 await assert.rejects(pending,{message:'ABORTED'})
})
const pixel=()=>new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'))

test('native analysis picture and provenance commit atomically with bounded image validation',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-analysis-picture',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const imageBytes=PNG.sync.write({width:1,height:1,data:Buffer.from([255,0,0,255])})
 const base64=imageBytes.toString('base64')
 const target={slide:0},offset={x:0,y:0,cx:952500,cy:952500}
 const picture={op:'addPicture',target,offset,ext:'png',bytes:'data:image/png;base64,'+base64,descr:'Analysis chart'}
 const provenance={op:'addElement',target,offset,kind:'textbox',paragraphs:[{runs:[{text:'Frozen input provenance'}]}]}
 await assert.rejects(()=>session.apply(0,[picture,picture]),{message:'INVALID_MEDIA'})
 await assert.rejects(()=>session.apply(0,[{...picture,bytes:'data:image/jpeg;base64,'+base64,ext:'jpg'}]),{message:'INVALID_MEDIA'})
 await assert.rejects(()=>session.apply(0,[{...picture,bytes:picture.bytes+'!'}]),{message:'INVALID_MEDIA'})
 const truncated=imageBytes.subarray(0,24).toString('base64')
 await assert.rejects(()=>session.apply(0,[{...picture,bytes:'data:image/png;base64,'+truncated},provenance]),{message:'INVALID_MEDIA'})
 const corrupt=Buffer.from(imageBytes);corrupt[corrupt.length-1]^=1
 await assert.rejects(()=>session.apply(0,[{...picture,bytes:'data:image/png;base64,'+corrupt.toString('base64')},provenance]),{message:'INVALID_MEDIA'})
 const unreadable=Buffer.from(imageBytes),idat=unreadable.indexOf('IDAT')
 const idatEnd=idat+4+unreadable.readUInt32BE(idat-4)
 unreadable[idat+4]=0
 unreadable.writeUInt32BE(crc32(unreadable.subarray(idat,idatEnd)),idatEnd)
 await assert.rejects(()=>session.apply(0,[{...picture,bytes:'data:image/png;base64,'+unreadable.toString('base64')},provenance]),{message:'INVALID_MEDIA'})
 await assert.rejects(()=>session.apply(0,[picture,{...provenance,paragraphs:[{runs:[{text:' '}]}]}]),{message:'INVALID_MEDIA'})
 await assert.rejects(()=>session.apply(0,[picture,provenance],undefined,{isolation:'per_op'}),{message:'INVALID_MEDIA'})
 await assert.rejects(()=>session.apply(0,[picture,{...provenance,target:{slide:1}}]),{message:'INVALID_MEDIA'})
 const nonexistent={slide:99}
 const rejected=await session.apply(0,[{...picture,target:nonexistent},{...provenance,target:nonexistent}])
 assert.equal(rejected.transaction.applied,false)
 assert.equal(rejected.generation,0)
 const applied=await session.apply(0,[picture,provenance])
 assert.equal(applied.generation,1)
 assert.deepEqual(applied.records[0].op,{op:'addPicture'})
 const rendered=await session.render(1,0)
 assert.equal(rendered.nodes.filter(node=>node.type==='picture').length,1)
 const archive=await JSZip.loadAsync((await session.exportBytes(1)).bytes)
 const imageParts=await Promise.all(archive.file(/^ppt\/media\/.+\.png$/).map(part=>part.async('nodebuffer')))
 assert.ok(imageParts.some(image=>image.equals(imageBytes)))
 assert.match(await archive.file('ppt/slides/slide1.xml').async('string'),/Frozen input provenance/)
 const undone=await session.undo(1)
 assert.equal(undone.stateGeneration,0)
 assert.equal(undone.slides[0].nodes.filter(node=>node.type==='picture').length,0)
 const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z','base64')
 const asJpeg=bytes=>({...picture,ext:'jpg',bytes:'data:image/jpeg;base64,'+bytes.toString('base64')})
 await assert.rejects(()=>session.apply(undone.generation,[asJpeg(jpeg.subarray(0,-2)),provenance]),{message:'INVALID_MEDIA'})
 const withoutHuffmanTables=Buffer.concat([jpeg.subarray(0,jpeg.indexOf(Buffer.from([0xff,0xc4]))),jpeg.subarray(jpeg.indexOf(Buffer.from([0xff,0xda])))])
 await assert.rejects(()=>session.apply(undone.generation,[asJpeg(withoutHuffmanTables),provenance]),{message:'INVALID_MEDIA'})
 assert.equal((await session.apply(undone.generation,[asJpeg(jpeg),provenance])).transaction.applied,true)
})

test('isolated AI history batches restore the exact pre-run deck and remain undoable',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-ai-history',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const original=await session.renderAll(0)
 assert.equal(await session.beginHistoryBatch(0),true)
 assert.equal(await session.beginHistoryBatch(0),true)
 await session.apply(0,[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'AI changed'}]}]}])
 assert.equal((await session.endHistoryBatch(1)).snapshotId,null)
 await session.apply(1,[{op:'setNotes',target:{slide:0},text:'AI changed notes'}])
 const {snapshotId,canUndo}=await session.endHistoryBatch(2)
 assert.equal(canUndo,true)
 assert.equal(typeof snapshotId,'number')
 const changed=await session.renderAll(2)
 const restored=await session.restoreSnapshot(2,snapshotId)
 assert.deepEqual(restored.slides,original)
 assert.equal(restored.stateGeneration,0)
 assert.equal(await session.notes(restored.generation,0),'')
 const undone=await session.undo(restored.generation)
 assert.deepEqual(undone.slides,changed)
 assert.equal(await session.notes(undone.generation,0),'AI changed notes')
 assert.equal(await session.restoreSnapshot(undone.generation,snapshotId),null)
 await assert.rejects(()=>session.beginHistoryBatch(0),{message:'GENERATION_CONFLICT'})
 assert.equal(await session.beginHistoryBatch(undone.generation),true)
 assert.equal((await session.endHistoryBatch(undone.generation)).snapshotId,null)
})

test('native AI batch is one undo step and evicted snapshots cannot restore a different deck',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-ai-eviction',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const original=await session.renderAll(0)
 await session.beginHistoryBatch(0)
 await session.apply(0,[{op:'setNotes',target:{slide:0},text:'first'}])
 await session.apply(1,[{op:'setNotes',target:{slide:0},text:'second'}])
 const {snapshotId:first}=await session.endHistoryBatch(2)
 const undone=await session.undo(2)
 assert.deepEqual(undone.slides,original)
 assert.equal(await session.notes(undone.generation,0),'')
 let generation=undone.generation
 for(let index=0;index<9;index++){
  await session.beginHistoryBatch(generation)
  const applied=await session.apply(generation,[{op:'setNotes',target:{slide:0},text:'later '+index}]);generation=applied.generation
  await session.endHistoryBatch(generation)
 }
 assert.equal(await session.restoreSnapshot(generation,first),null)
 assert.equal(await session.notes(generation,0),'later 8')
})

test('AI checkpoint survives undo followed by a user edit without aliasing live slides',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-ai-alias',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const original=await session.renderAll(0)
 await session.beginHistoryBatch(0)
 await session.apply(0,[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'AI change'}]}]}])
 const {snapshotId:checkpoint}=await session.endHistoryBatch(1)
 const undone=await session.undo(1)
 const edited=await session.apply(undone.generation,[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'later user change'}]}]}])
 const restored=await session.restoreSnapshot(edited.generation,checkpoint)
 assert.deepEqual(restored.slides,original)
 assert.equal(restored.stateGeneration,0)
})

test('isolated session parses untrusted bytes in a child process and stays generation-fenced',async t=>{
 const raw=await bytes()
 const session=await openIsolatedPptxSession({fileId:'f-isolated',revision:'r-1',bytes:raw},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 assert.deepEqual(session.binding,{fileId:'f-isolated',revision:'r-1'})
 const outline=await session.outline(0)
 assert.equal(outline.count,2)
 assert.deepEqual(outline.paths,['ppt/slides/slide1.xml','ppt/slides/slide2.xml'])
 const layoutResult=await session.layouts(0)
 assert.ok(layoutResult.layouts.length>0)
 assert.equal(layoutResult.size.cx,outline.size.cx)
 assert.ok(layoutResult.layouts.every(layout=>typeof layout.path==='string'&&Array.isArray(layout.placeholders)))
 assert.ok(outline.defaultFont && outline.defaultFont.length>0)
 const applied=await session.apply(0,[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'child edited'}]}]}])
 assert.equal(applied.generation,1)
 assert.equal(applied.stateGeneration,1)
 assert.deepEqual(applied.slideIds,['s_1','s_2'])
 assert.ok(applied.records[0].slideId==='s_1')
 const render=await session.render(1,0,1280)
 assert.equal(render.widthPx,1280)
 assert.equal(render.partPath,'ppt/slides/slide1.xml')
 const exported=await session.exportBytes(1)
 assert.equal(exported.generation,1)
 assert.deepEqual([...exported.bytes.slice(0,2)],[0x50,0x4b],'export starts with the ZIP magic')
 await assert.rejects(()=>session.apply(0,[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'stale'}]}]}]),{message:'GENERATION_CONFLICT'})
 const undone=await session.undo(1)
 assert.equal(undone.generation,2)
 assert.equal(undone.stateGeneration,0)
 assert.equal(undone.slides.length,2)
 const redone=await session.redo(2)
 assert.equal(redone.generation,3)
 assert.equal(redone.stateGeneration,1)
 assert.equal(redone.slides.length,2)
})

test('isolated session supports GenOffice dry-run and per-op transaction semantics',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-txn',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const dryRun=await session.apply(0,[{op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'preview'}]}]}],undefined,{dryRun:true})
 assert.equal(dryRun.generation,0)
 assert.equal(dryRun.transaction.dryRun,true)
 assert.equal(dryRun.transaction.plan.length,1)
 const rejected=await session.apply(0,[
  {op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'must roll back'}]}]},
  {op:'setText',target:{slide:0,el:'missing'},paragraphs:[{runs:[{text:'invalid'}]}]},
 ])
 assert.equal(rejected.generation,0)
 assert.equal(rejected.transaction.applied,false)
 assert.equal(rejected.transaction.failures[0].index,1)
 const partial=await session.apply(0,[
  {op:'setText',target:{slide:0,el:'e_904989a1'},paragraphs:[{runs:[{text:'child edited'}]}]},
  {op:'setText',target:{slide:0,el:'missing'},paragraphs:[{runs:[{text:'skipped'}]}]},
 ],undefined,{isolation:'per_op'})
 assert.equal(partial.generation,1)
 assert.equal(partial.transaction.applied,true)
 assert.equal(partial.transaction.records.length,1)
 assert.equal(partial.transaction.failures.length,1)
 const beforeNotes=await session.notes(1,0)
 const noted=await session.apply(1,[{op:'setNotes',target:{slide:0},text:'Session speaker note'}])
 assert.equal(noted.generation,2)
 assert.equal(await session.notes(2,0),'Session speaker note')
 await session.undo(2)
 assert.equal(await session.notes(3,0),beforeNotes)
})

test('isolated session accepts GenOffice picture and background operations',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-genoffice-ops',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const inserted=await session.applyImage(0,{mode:'insert',slide:0,offset:{x:0,y:0,cx:914400,cy:914400},bytes:pixel(),ext:'png'})
 const pictureId=inserted.created[0]?.id
 assert.ok(pictureId)
 const result=await session.apply(inserted.generation,[
  {op:'setBackground',target:{slide:0},kind:'solid',color:'#123456'},
  {op:'setPictureSrcRect',target:{slide:0,el:pictureId},srcRect:{l:0.1,t:0.1,r:0.1,b:0.1}},
  {op:'setPictureOpacity',target:{slide:0,el:pictureId},opacity:0.6},
 ])
 assert.equal(result.generation,2)
 assert.equal(result.records.length,3)
})

test('isolated session accepts GenOffice chart and SmartArt insert operations',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-genoffice-inserts',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const result=await session.apply(0,[
  {op:'addChart',target:{slide:0},kind:'bar',title:'Revenue',categories:['Q1','Q2'],series:[{name:'Sales',values:[12,18]}],offset:{x:914400,y:914400,cx:3657600,cy:2743200}},
  {op:'addSmartArt',target:{slide:0},layout:'process',items:['Plan','Build','Ship'],offset:{x:5486400,y:914400,cx:3657600,cy:1828800}},
 ])
 assert.equal(result.generation,1)
 assert.deepEqual(result.records.map(record=>record.op.op),['addChart','addSmartArt'])
 assert.ok(result.created.length>=1)
 const rendered=await session.render(1,0)
 assert.ok(rendered.nodes.some(node=>node.type==='chart'))
 assert.ok(rendered.nodes.some(node=>node.type==='group'))
})

test('isolated session moves a grouped child in rendered slide coordinates',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-script-group',revision:'r1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const inserted=await session.apply(0,[{
  op:'addSmartArt',target:{slide:0},layout:'process',items:['Plan','Build','Ship'],
  offset:{x:5486400,y:914400,cx:3657600,cy:1828800},
 }])
 const before=await session.render(inserted.generation,0)
 const group=before.nodes.find(node=>node.type==='group'&&node.sourceId&&node.children.some(child=>child.sourceId&&child.type==='shape'))
 assert.ok(group)
 const child=group.children.find(child=>child.sourceId&&child.type==='shape')
 const {x,y,w,h,rotationDeg}=child.box
 const {mapScriptOpsForWidth}=await import('../../../../packages/pptx-ops/src/ops/script-map.ts')
 const ops=mapScriptOpsForWidth(inserted.size.cx,{
  slideIndex:0,fitWidthPx:before.widthPx,edits:[],
  boxes:[{id:child.sourceId,groupId:group.sourceId,x:group.box.x+x+10,y:group.box.y+y,w,h,rotation:rotationDeg}],
 })
 const moved=await session.apply(inserted.generation,ops)
 assert.equal(moved.transaction.applied,true,JSON.stringify(moved.transaction))
 const saved=await session.exportBytes(moved.generation)
 const reopened=await openIsolatedPptxSession({fileId:'f-script-group',revision:'r2',bytes:saved.bytes},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>reopened.close())
 const resized=await reopened.render(0,0)
 const savedGroup=resized.nodes[before.nodes.indexOf(group)]
 assert.equal(savedGroup.type,'group')
 const savedChild=savedGroup.children[group.children.indexOf(child)]
 assert.equal(savedChild.type,child.type)
 const savedBox=savedChild.box
 assert.ok(Math.abs(savedBox.x-x-10)<0.1,JSON.stringify(savedBox))
 assert.ok(Math.abs(savedBox.w-w)<0.1,JSON.stringify(savedBox))
})

test('isolated session edits a chart atomically after import confirmation',async t=>{
 const source=await openIsolatedPptxSession({fileId:'f-chart-source',revision:'r-source',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>source.close())
 const inserted=await source.apply(0,[{op:'addChart',target:{slide:0},kind:'bar',categories:['A','B'],series:[{name:'Sales',values:[2,4]}],offset:{x:95250,y:95250,cx:3000000,cy:2000000}}])
 const createdId=inserted.created.at(-1)?.id
 assert.ok(createdId)
 const zip=await JSZip.loadAsync((await source.exportBytes(inserted.generation)).bytes)
 const path='ppt/slides/slide1.xml',xml=await zip.file(path).async('string')
 assert.match(xml,/ descr="aislides-chart"/)
 zip.file(path,xml.replace(' descr="aislides-chart"',''))
 const importedBytes=await zip.generateAsync({type:'uint8array'})
 const session=await openIsolatedPptxSession({fileId:'f-chart',revision:'r-chart',bytes:importedBytes},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const first=await session.render(0,0,1280)
 const chart=first.nodes.find(node=>node.type==='chart')
 assert.ok(chart)
 const chartId=chart.sourceId
 assert.notEqual(chart.appCreated,true)
 await assert.rejects(()=>session.apply(0,[{op:'setChart',target:{slide:0,el:chartId},patch:{title:'Unconfirmed'}}]),{message:'UNSUPPORTED_OP'})
 const result=await session.editChart(0,0,chartId,{title:'Updated',colorScheme:'mono-accent1',catAxisTitle:'Period',valAxisTitle:'Revenue',gapWidthPct:44,pointColors:{0:{0:'#224466'}}})
 assert.equal(result.generation,1)
 assert.notEqual(result.sourceId,chartId)
 assert.ok(result.slide.nodes.find(node=>node.sourceId===result.sourceId).labels.some(label=>label.text==='Updated'))
 const confirmedBytes=(await session.exportBytes(result.generation)).bytes
 const confirmed=await openIsolatedPptxSession({fileId:'f-chart-confirmed',revision:'r-confirmed',bytes:confirmedBytes},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>confirmed.close())
 assert.equal((await confirmed.render(0,0,1280)).nodes.find(node=>node.type==='chart').appCreated,true)
 assert.deepEqual(await session.undo(result.generation).then(view=>[view.generation,view.canRedo]),[2,true])
 const undone=await session.render(2,0,1280)
 assert.equal(undone.nodes.find(node=>node.type==='chart').labels.some(label=>label.text==='Updated'),false)
 assert.notEqual(undone.nodes.find(node=>node.type==='chart').appCreated,true)
 const exported=await session.exportBytes(2)
 const reopened=await openIsolatedPptxSession({fileId:'f-chart-export',revision:'r-chart-export',bytes:exported.bytes},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>reopened.close())
 const saved=await reopened.render(0,0,1280)
 assert.notEqual(saved.nodes.find(node=>node.type==='chart').appCreated,true)
})

test('isolated session generates a PPTX page and lands it as one undoable edit',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-generated-page',revision:'r-generated-page',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const generated=await session.generatePage(0,JSON.stringify({background:'#102030',elements:[{type:'text',x:80,y:80,w:900,h:120,paragraphs:[{runs:[{text:'Generated page',sizePt:36,bold:true,color:'#FFFFFF'}]}]}]}),[])
 assert.equal(generated.imageFailures.length,0)
 const landed=await session.landGeneratedPages(0,[generated.marker],'append')
 assert.equal(landed.generation,1)
 assert.equal(landed.count,3)
 assert.equal(landed.created.length,1)
 const deck=await session.renderAll(landed.generation,1280)
 assert.equal(deck.length,3)
 assert.ok(deck[2].nodes.some(node=>node.type==='text'&&node.text?.lines.map(line=>line.runs.map(run=>run.text).join('')).join('')==='Generated page'))
 const undone=await session.undo(landed.generation)
 assert.equal(undone.generation,2)
 assert.equal(undone.slides.length,2)
})

test('replacing a 4:3 deck uses the generated canvas and preserves it after export',async t=>{
 const session=await openIsolatedPptxSession({fileId:'generated-replace',revision:'r1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const resized=await session.apply(0,[{op:'setSlideSize',cx:9144000,cy:6858000}])
 const generated=await session.generatePage(resized.generation,JSON.stringify({elements:[{
  type:'text',x:1050,y:80,w:180,h:120,paragraphs:[{runs:[{text:'Right side',sizePt:20}]}],
 }]}),[])
 const landed=await session.landGeneratedPages(resized.generation,[generated.marker],'replace')
 assert.deepEqual(landed.size,{cx:12192000,cy:6858000})
 assert.equal(landed.count,1)
 const reopen=await openIsolatedPptxSession({fileId:'generated-replace',revision:'r2',bytes:(await session.exportBytes(landed.generation)).bytes},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>reopen.close())
 const slide=await reopen.render(0,0,1280)
 const label=slide.nodes.find(node=>node.type==='text'&&node.text?.lines.some(line=>line.runs.map(run=>run.text).join('')==='Right side'))
 assert.equal(slide.heightPx,720)
 assert.ok(label&&Math.abs(label.box.x-1050)<0.1&&label.box.x+label.box.w<=slide.widthPx,JSON.stringify(slide.nodes.map(({type,box,text})=>({type,box,text}))))
 const undone=await session.undo(landed.generation)
 assert.deepEqual(undone.size,resized.size)
 assert.equal(undone.slides.length,2)
})

test('isolated AI ops preserve paragraph, shape and table formatting in the PPTX',async t=>{
 const session=await openIsolatedPptxSession({fileId:'ai-formatting',revision:'r1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const target={slide:0,el:'e_904989a1'}
 const edits=[
  {op:'setText',target,paragraphs:[{runs:[{text:'Formatted item'}],bullet:'char',bulletChar:'◆',lineSpacingPct:125,spaceBeforePt:4,spaceAfterPt:7,rtl:true}]},
  {op:'setFill',target,fill:{path:'circle',stops:[{pos:0,color:'#FFFFFF'},{pos:1,color:'#123456'}]}},
  {op:'setStroke',target,stroke:{color:'#123456',widthEmu:25400,cap:'rnd',join:'bevel',compound:'dbl'}},
  {op:'addTable',target:{slide:0},offset:{x:952500,y:3810000,cx:3000000,cy:1200000},
   rows:2,cols:2,cells:[['Merged header',''],['A','B']],colWidthsEmu:[1000000,2000000],rowHeightsEmu:[450000,750000],
   cellProps:[[{gridSpan:2,anchor:'ctr'},{hMerge:true}]]},
 ]
 const changed=await session.apply(0,edits)
 assert.equal(changed.transaction.applied,true,JSON.stringify(changed.transaction))
 const exported=await session.exportBytes(changed.generation)
 const zip=await JSZip.loadAsync(exported.bytes)
 const xml=await zip.file('ppt/slides/slide1.xml').async('string')
 for(const pattern of [/<a:buChar char="◆"/, /<a:spcPct val="125000"/, /<a:spcBef><a:spcPts val="400"/, /<a:spcAft><a:spcPts val="700"/, /rtl="1"/,
  /<a:path path="circle"/, /cap="rnd"/, /cmpd="dbl"/, /<a:bevel\s*\//, /<a:gridCol w="1000000"/, /<a:gridCol w="2000000"/,
  /<a:tr h="450000"/, /<a:tr h="750000"/, /gridSpan="2"/, /hMerge="1"/, /Merged header/])assert.match(xml,pattern)
 await assert.rejects(session.apply(changed.generation,[{...edits[3],cellProps:[[{anchor:'ctr" unsafe="1'}]]}]),{message:'INVALID_TABLE'})
 await assert.rejects(session.apply(changed.generation,[{...edits[1],fill:{...edits[1].fill,path:'unsupported'}}]),{message:'INVALID_FILL'})
 const coveredText=await session.apply(changed.generation,[{...edits[3],cells:[['Header','Would be lost'],['A','B']]}])
 assert.equal(coveredText.transaction.applied,false)
 assert.match(coveredText.transaction.failures[0].error,/put text in the merge anchor/)
 assert.equal((await session.exportBytes(changed.generation)).sha256,exported.sha256)
 const tableTarget={slide:0,el:changed.transaction.records[3].created[0]}
 const formatted=await session.apply(changed.generation,[
  {op:'setTableCell',target:tableTarget,row:1,col:0,paragraphs:[{runs:[{text:'Cell item'}],bullet:'char',bulletChar:'◇'}]},
  {op:'setTableStyle',target:tableTarget,shadingColor:'#CC8844'},
  {op:'setTableStyle',target:tableTarget,styleId:'{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}',keepFormatting:true},
  {op:'setTransform',target:tableTarget,box:{x:952500,y:3810000,cx:6000000,cy:2400000},resizeTableGrid:true},
 ])
 assert.equal(formatted.transaction.applied,true,JSON.stringify(formatted.transaction))
 const saved=await JSZip.loadAsync((await session.exportBytes(formatted.generation)).bytes)
 const savedXml=await saved.file('ppt/slides/slide1.xml').async('string')
 assert.match(savedXml,/<a:buChar char="◇"[^>]*\/>[\s\S]*?Cell item/)
 assert.match(savedXml,/<a:srgbClr val="CC8844"/i)
 assert.match(savedXml,/<a:gridCol w="2000000"\/><a:gridCol w="4000000"/)
})

test('isolated session accepts GenOffice link, timing, animation and connector operations',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-genoffice-ai-ops',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const initial=await session.render(0,0)
 assert.ok(initial.nodes.length>=2)
 const from='e_904989a1',to='e_eb117e0a'
 const first=await session.apply(0,[
  {op:'setLink',target:{slide:0,el:from},link:{kind:'url',url:'https://example.test/'}},
  {op:'setAdvanceTime',target:{slide:0},ms:5000},
  {op:'addAnimation',target:{slide:0,el:from},effect:'fade',duration:400},
  {op:'addConnector',target:{slide:0},from,to,kind:'elbow',arrow:'end'},
 ])
 assert.equal(first.generation,1,JSON.stringify(first.transaction))
 assert.deepEqual(first.records.map(record=>record.op.op),['setLink','setAdvanceTime','addAnimation','addConnector'])
 const connectorId=first.records[3]?.created?.[0]
 assert.ok(connectorId)
 const second=await session.apply(1,[{op:'setConnectorEndpoints',target:{slide:0,el:connectorId},p1:{x:914400,y:914400},p2:{x:3657600,y:2743200}}])
 assert.equal(second.generation,2)
 const third=await session.apply(2,[{op:'addAnimation',target:{slide:0,el:to},effect:'appear'}])
 assert.equal(third.generation,3)
 const fourth=await session.apply(3,[{op:'reorderAnimation',target:{slide:0},seq:0,to:1}])
 assert.equal(fourth.generation,4)
 const fifth=await session.apply(4,[{op:'removeAnimation',target:{slide:0},seq:0}])
 assert.equal(fifth.generation,5)
})

test('isolated session accepts GenOffice page-size, arrange, equation and theme operations',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-genoffice-layout-ops',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const result=await session.apply(0,[
  {op:'setSlideSize',cx:9144000,cy:6858000},
  {op:'alignElements',target:{slide:0},els:['e_904989a1','e_eb117e0a'],mode:'left'},
  {op:'distributeElements',target:{slide:0},els:['e_904989a1','e_eb117e0a'],axis:'horizontal',to:'slide'},
  {op:'insertEquation',target:{slide:0,el:'e_904989a1'},latex:'x^2 + y^2',position:'end'},
  {op:'applyTheme',name:'AI palette',colors:{accent1:'#123456',lt1:'#FFFFFF'}},
 ])
 assert.equal(result.generation,1,JSON.stringify(result.transaction))
 assert.deepEqual(result.records.map(record=>record.op.op),['setSlideSize','alignElements','distributeElements','insertEquation','applyTheme'])
 assert.deepEqual(result.size,{cx:9144000,cy:6858000})
 const rendered=await session.render(1,0)
 assert.equal(rendered.widthPx,960)
 const undone=await session.undo(1)
 assert.deepEqual(undone.size,{cx:12192000,cy:6858000})
 const redone=await session.redo(2)
 assert.deepEqual(redone.size,{cx:9144000,cy:6858000})
})

test('isolated session preserves AI preset shape adjustments after export and reopen',async t=>{
 const source=await bytes(),session=await openIsolatedPptxSession({fileId:'f-adjustments',revision:'r1',bytes:source},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const op={op:'addElement',target:{slide:0},kind:'roundRect',offset:{x:914400,y:2286000,cx:3200400,cy:1600200},fill:'#E8F0FE',adjustments:{adj:16667}}
 const plan=await session.apply(0,[op],undefined,{dryRun:true})
 assert.equal(plan.generation,0)
 assert.equal(plan.transaction.failures?.length??0,0)
 const changed=await session.apply(0,[op])
 assert.equal(changed.generation,1)
 const exported=await session.exportBytes(1)
 const zip=await JSZip.loadAsync(exported.bytes)
 assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"\/>/)
 const reopened=await openIsolatedPptxSession({fileId:'f-adjustments',revision:'r2',bytes:exported.bytes},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>reopened.close())
 const reexported=await JSZip.loadAsync((await reopened.exportBytes(0)).bytes)
 assert.match(await reexported.file('ppt/slides/slide1.xml').async('string'),/<a:gd name="adj" fmla="val 16667"\/>/)
 for(const adjustments of [[],{adj:'16667'},{adj:2147483648},{'bad guide':100}]){
  await assert.rejects(session.apply(1,[{...op,adjustments}]),{message:'INVALID_GEOMETRY'})
 }
 assert.equal((await session.exportBytes(1)).sha256,exported.sha256)
})

test('isolated session accepts GenOffice redaction, freeform and review-comment operations',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-genoffice-privacy-ops',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const inserted=await session.applyImage(0,{mode:'insert',slide:0,offset:{x:0,y:0,cx:914400,cy:914400},bytes:pixel(),ext:'png'})
 const pictureId=inserted.created[0]?.id
 assert.ok(pictureId)
 const result=await session.apply(inserted.generation,[
  {op:'setRedaction',target:{slide:0,el:pictureId},label:'brand mark'},
  {op:'setShapeCustomGeometry',target:{slide:0,el:'e_904989a1'},path:{w:914400,h:914400,cmds:[{op:'M',pts:[0,0]},{op:'L',pts:[914400,0]},{op:'L',pts:[914400,914400]},{op:'Z',pts:[]}]}},
  {op:'addComment',target:{slide:0},author:'AI Assistant',text:'Review this visual.'},
 ])
 assert.equal(result.generation,2,JSON.stringify(result.transaction))
 assert.deepEqual(result.records.map(record=>record.op.op),['setRedaction','setShapeCustomGeometry','addComment'])
})

test('isolated session applies bounded image bytes through the generation-fenced media command',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-image',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const inserted=await session.applyImage(0,{mode:'insert',slide:0,offset:{x:0,y:0,cx:914400,cy:914400},bytes:pixel(),ext:'png'})
 assert.equal(inserted.generation,1)
 const sourceId=inserted.created[0]?.id
 assert.ok(sourceId)
 assert.equal((await session.render(1,0)).nodes.some(node=>node.type==='picture'&&node.sourceId===sourceId),true)
 const replaced=await session.applyImage(1,{mode:'replace',slide:0,sourceId,bytes:pixel(),ext:'png'})
 assert.equal(replaced.generation,2)
 const undone=await session.undo(2)
 assert.equal(undone.generation,3)
 assert.equal(undone.slides[0].nodes.some(node=>node.type==='picture'&&node.sourceId===sourceId),true)
 await assert.rejects(()=>session.applyImage(3,{mode:'insert',slide:0,offset:{x:0,y:0,cx:914400,cy:914400},bytes:new Uint8Array([1,2,3]),ext:'png'}),{message:'INVALID_MEDIA'})
 await assert.rejects(()=>session.applyImage(2,{mode:'insert',slide:0,offset:{x:0,y:0,cx:914400,cy:914400},bytes:pixel(),ext:'png'}),{message:'GENERATION_CONFLICT'})
})

test('oversized input never reaches a child process',async()=>{
 await assert.rejects(()=>openIsolatedPptxSession({fileId:'f',revision:'r',bytes:new Uint8Array(32*1024*1024+1)},{unsafeTestOnly:true}),{message:'INPUT_LIMIT'})
})

test('a rejected PPTX open does not leave the session process running',()=>{
 const host=new URL('../../worker/src/native/pptx-session-host.ts',import.meta.url).href
 const result=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
  import assert from 'node:assert/strict'
  import {openIsolatedPptxSession} from ${JSON.stringify(host)}
  await assert.rejects(openIsolatedPptxSession(
   {fileId:'invalid',revision:'r1',bytes:Uint8Array.of(1,2,3)},
   {unsafeTestOnly:true},
  ))
  process.stdout.write('open rejected')
 `],{env:{...process.env,NODE_ENV:'test'},encoding:'utf8',timeout:8000})
 assert.equal(result,'open rejected')
})

test('close() terminates the child process and settles later calls',async()=>{
 const raw=await bytes()
 const session=await openIsolatedPptxSession({fileId:'f-close',revision:'r',bytes:raw},{timeoutMs:60000,unsafeTestOnly:true})
 session.close()
 await assert.rejects(()=>session.outline(0),{message:'SESSION_CLOSED'})
 await assert.rejects(()=>session.apply(0,[{op:'addBlankSlide',target:{slide:0}}]),{message:'SESSION_CLOSED'})
})

test('a killed child fails pending and later calls with SESSION_CLOSED',async()=>{
 const raw=await bytes()
 const session=await openIsolatedPptxSession({fileId:'f-kill',revision:'r',bytes:raw},{timeoutMs:60000,unsafeTestOnly:true})
 await session.outline(0)
 // Kill the underlying child directly: the proxy learns about it through exit.
 const found=await new Promise(resolve=>{
   const probe=spawn('bash',['-c',`ps -o pid=,args= --ppid ${process.pid} | grep "pptx-session-child.ts" | grep -v grep | awk '{print $1}'`],{stdio:['ignore','pipe','pipe']})
   let out=''
   probe.stdout.on('data',chunk=>{out+=chunk})
   probe.on('close',()=>resolve(out.trim().split('\n').filter(Boolean).map(Number)))
 })
 assert.ok(found.length>=1,'a session child process must exist')
 for (const pid of found) process.kill(pid,'SIGKILL')
 await new Promise(resolve=>setTimeout(resolve,150))
 await assert.rejects(()=>session.outline(0),{message:'SESSION_CLOSED'})
 await assert.rejects(()=>session.exportBytes(0),{message:'SESSION_CLOSED'})
})

test('native links and animations address the rendered target after editing and reopening',async t=>{
 const session=await openIsolatedPptxSession({fileId:'links-animation',revision:'r1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true});t.after(()=>session.close())
 const durableId='e_904989a1'
 const link={kind:'url',url:'https://example.com/report'}
 const timing={effect:'fade',trigger:'onClick',durationMs:750,delayMs:150}
 const items=[{sourceId:durableId,...timing}]
 const apply=await session.apply(0,[{op:'setLink',target:{slide:0,el:durableId},link},{op:'setAnimations',target:{slide:0},items}])
 assert.equal(apply.transaction.applied,true,JSON.stringify(apply.transaction))
 async function checkTargets(current,generation,expectedTiming){
  const slide=await current.render(generation,0)
  const title=slide.nodes.find(node=>node.type==='text'&&node.text?.lines.flatMap(line=>line.runs.map(run=>run.text)).join('')==='Acceptance title')
  assert.ok(title?.sourceId)
  assert.ok((await current.links(generation,0)).some(item=>item.sourceId===title.sourceId&&item.target.url===link.url))
  const animations=(await current.animations(generation,0)).map(({targetName,...item})=>item)
  assert.deepEqual(animations,[{sourceId:title.sourceId,...expectedTiming}])
  return animations[0]
 }
 await checkTargets(session,1,timing)
 await assert.rejects(()=>session.animations(0,0),{message:'GENERATION_CONFLICT'})
 await assert.rejects(()=>session.apply(1,[{op:'setAnimations',target:{slide:0},items:[{...items[0],unexpected:true}]}]))
 await assert.rejects(()=>session.apply(1,[{op:'setLink',target:{slide:0,el:durableId},link:{kind:'url',url:'javascript:alert(1)'}}]))
 const output=await session.exportBytes(1),fresh=await openIsolatedPptxSession({fileId:'links-animation',revision:'r2',bytes:output.bytes},{timeoutMs:60000,unsafeTestOnly:true});t.after(()=>fresh.close())
 const animation=await checkTargets(fresh,0,timing)
 const updated=await fresh.apply(0,[{op:'setAnimations',target:{slide:0},items:[{...animation,durationMs:500}]}])
 assert.equal(updated.transaction.applied,true,JSON.stringify(updated.transaction))
 await checkTargets(fresh,1,{...timing,durationMs:500})
})


test('chart data and theme palettes read current edits and survive export reopen',async t=>{
 const session=await openIsolatedPptxSession({fileId:'f-chart-reads',revision:'r1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true});t.after(()=>session.close())
 const added=await session.apply(0,[{op:'addChart',target:{slide:0},kind:'bar',title:'Before',categories:['A','B'],series:[{name:'Sales',values:[2,4]}],offset:{x:95250,y:95250,cx:3000000,cy:2000000}}])
 const chart=(await session.render(added.generation,0)).nodes.find(node=>node.type==='chart')
 const data=await session.chartData(added.generation,0,chart.sourceId)
 assert.equal(data.title,'Before');assert.deepEqual(data.series,[{name:'Sales',values:[2,4]}])
 assert.equal(await session.chartData(added.generation,0,'missing'),null)
 const schemes=await session.chartColorSchemes(added.generation)
 assert.deepEqual(schemes.map(item=>item.key),['default','colorful','colorful2',...Array.from({length:6},(_,i)=>`mono-accent${i+1}`)])
 assert.equal(schemes[1].colors.length,6)
 const edited=await session.editChart(added.generation,0,chart.sourceId,{title:'After',series:[{name:'Sales',values:[7,9]}],colorScheme:'mono-accent1'})
 await assert.rejects(()=>session.chartData(added.generation,0,chart.sourceId),{message:'GENERATION_CONFLICT'})
 const expected=await session.chartData(edited.generation,0,edited.sourceId)
 assert.equal(expected.title,'After');assert.deepEqual(expected.series,[{name:'Sales',values:[7,9]}])
 const reopened=await openIsolatedPptxSession({fileId:'f-chart-reads',revision:'r2',bytes:(await session.exportBytes(edited.generation)).bytes},{timeoutMs:60000,unsafeTestOnly:true});t.after(()=>reopened.close())
 const saved=(await reopened.render(0,0)).nodes.find(node=>node.type==='chart')
 assert.deepEqual(await reopened.chartData(0,0,saved.sourceId),expected)
 assert.deepEqual(await reopened.chartColorSchemes(0),schemes)
})


test('chart palette offers only accents present in a partial theme like PC',async t=>{
 const zip=await JSZip.loadAsync(await bytes())
 for(const path of Object.keys(zip.files).filter(path=>/^ppt\/theme\/theme\d+\.xml$/.test(path))){const xml=await zip.file(path).async('string');zip.file(path,xml.replace(/<a:accent[456]>[\s\S]*?<\/a:accent[456]>/g,''))}
 const session=await openIsolatedPptxSession({fileId:'f-partial-theme',revision:'r1',bytes:await zip.generateAsync({type:'uint8array'})},{timeoutMs:60000,unsafeTestOnly:true});t.after(()=>session.close())
 const schemes=await session.chartColorSchemes(0)
 assert.equal(schemes.find(item=>item.key==='colorful').colors.length,3)
 assert.deepEqual(schemes.filter(item=>item.key.startsWith('mono')).map(item=>item.key),['mono-accent1','mono-accent2','mono-accent3'])
 for(const scheme of schemes)for(const color of scheme.colors)assert.match(color,/^#[0-9a-f]{6}$/i)
})

test('picture backgrounds and fills reuse media, save their OOXML and undo as a single edit',async t=>{
 const session=await openIsolatedPptxSession({fileId:'picture-fills',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const image=PNG.sync.write({width:1,height:1,data:Buffer.from([6,105,216,255])})
 const picture={bytes:image,ext:'png'}
 assert.equal((await session.applyImage(0,{mode:'background',slide:0,tile:false,...picture})).generation,1)
 const allBackgrounds=await session.applyImage(1,{mode:'background',slide:-1,sourceSlide:0,tile:true})
 assert.equal(allBackgrounds.generation,2)
 const targets=(await session.render(2,0)).nodes.filter(node=>(node.type==='text'||node.type==='shape')&&node.sourceId).map(node=>({sourceId:node.sourceId}))
 assert.ok(targets.length>=2)
 await assert.rejects(()=>session.applyImage(2,{mode:'fill',slide:0,tile:false,targets:[targets[0],{sourceId:'missing-shape'}],...picture}),{message:'INVALID_TARGET'})
 assert.equal((await session.applyImage(2,{mode:'fill',slide:0,tile:false,targets,...picture})).generation,3)
 const saved=await JSZip.loadAsync((await session.exportBytes(3)).bytes)
 const slide1=await saved.file('ppt/slides/slide1.xml').async('string')
 const slide2=await saved.file('ppt/slides/slide2.xml').async('string')
 for(const slide of [slide1,slide2])assert.match(slide,/<p:bg>.*?<a:blipFill.*?<a:tile/s)
 assert.ok((slide1.match(/<a:blipFill rotWithShape="1">/g)??[]).length>=targets.length)
 const rela=await saved.file('ppt/slides/_rels/slide1.xml.rels').async('string')
 const relb=await saved.file('ppt/slides/_rels/slide2.xml.rels').async('string')
 const fills=[...rela.matchAll(/Target="\.\.\/media\/([^"]+)"/g)].map(match=>match[1])
 const backgrounds=[...relb.matchAll(/Target="\.\.\/media\/([^"]+)"/g)].map(match=>match[1])
 assert.equal(new Set(fills).size,1)
 assert.ok(backgrounds.length===1&&fills.includes(backgrounds[0]))
 assert.deepEqual(await saved.file('ppt/media/'+backgrounds[0]).async('nodebuffer'),image)
 const undo=await session.undo(3)
 const undone=await JSZip.loadAsync((await session.exportBytes(undo.generation)).bytes)
 assert.doesNotMatch(await undone.file('ppt/slides/slide1.xml').async('string'),/<a:blipFill rotWithShape="1">/)
})

test('native Edit Points and connector reattachment are preserved in the saved slide',async t=>{
 const session=await openIsolatedPptxSession({fileId:'shape-geometry',revision:'r-1',bytes:await bytes()},{timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const elements=(await session.render(0,0)).nodes.filter(node=>(node.type==='text'||node.type==='shape')&&!node.decoration)
 const [from,destination]=elements.map(element=>element.sourceId)
 assert.ok(from&&destination)
 const created=await session.apply(0,[{op:'addConnector',target:{slide:0},from,to:destination}])
 assert.equal(created.transaction.applied,true,JSON.stringify(created.transaction))
 const connector=created.created[0]?.id
 assert.ok(connector)
 const changed=await session.apply(1,[
  {op:'setShapeCustomGeometry',target:{slide:0,el:from},path:{w:500,h:500,cmds:[{op:'M',pts:[0,0]},{op:'L',pts:[500,100]},{op:'L',pts:[500,500]},{op:'Z',pts:[]}]}},
  {op:'setConnectorEndpoints',target:{slide:0,el:connector},p1:{x:500000,y:600000},p2:{x:900000,y:800000},start:null,end:{targetId:from,idx:0}},
 ])
 assert.equal(changed.transaction.applied,true,JSON.stringify(changed.transaction))
 const archive=await JSZip.loadAsync((await session.exportBytes(changed.generation)).bytes)
 const xml=await archive.file('ppt/slides/slide1.xml').async('string')
 assert.match(xml,/<a:custGeom>.*?<a:pt x="500" y="100"\s*\/>.*?<\/a:custGeom>/s)
 const connection=xml.match(/<p:cxnSp>.*?<\/p:cxnSp>/s)?.[0]
 assert.ok(connection)
 assert.doesNotMatch(connection,/<a:stCxn/)
 assert.match(connection,/<a:endCxn id="\d+" idx="0"\s*\/>/)
})

test('PPTX slide info returns date modes and Morph keys for the rendered shapes',async t=>{
 const {openPptx,applyHeaderFooter,setSlideTransition,savePptx}=await import('@genoffice/pptx-engine')
 const deck=await openPptx(await bytes())
 assert.equal(applyHeaderFooter(deck,{date:'Fixed April date',dateAuto:false},[0]),true)
 assert.equal(applyHeaderFooter(deck,{date:'April 2026',dateAuto:true},[1]),true)
 setSlideTransition(deck.deck.slides[1],'morph')
 const open=(archive,revision)=>openIsolatedPptxSession({fileId:'slide-info-morph',revision,bytes:archive},
  {timeoutMs:60000,unsafeTestOnly:true})
 const session=await open(await savePptx(deck),'r1')
 t.after(()=>session.close())
 const [first,second]=await session.slideInfo(0)
 assert.deepEqual(first.headerFooter,{footer:null,slideNum:false,date:'Fixed April date',dateAuto:false})
 assert.deepEqual(second.headerFooter,{footer:null,slideNum:false,date:'April 2026',dateAuto:true})
 assert.equal(second.transition,'morph')
 const [firstShape,secondShape]=[first,second].map(info=>info.shapeKeys.find(key=>key.name==='Shape 3'))
 assert.equal(firstShape.spid,3)
 assert.equal(secondShape.spid,3)
 for(const [index,shape] of [firstShape,secondShape].entries()){
  const render=await session.render(0,index)
  assert.ok(render.nodes.some(node=>!node.decoration&&node.sourceId===shape.sourceId))
 }
 const updated=await session.apply(0,[{op:'applyHeaderFooter',settings:{...first.headerFooter}}])
 assert.equal(updated.transaction.applied,true)
 await assert.rejects(()=>session.slideInfo(0),/GENERATION_CONFLICT/)
 const reopened=await open((await session.exportBytes(updated.generation)).bytes,'r2')
 t.after(()=>reopened.close())
 assert.deepEqual((await reopened.slideInfo(0)).map(info=>info.headerFooter),[first.headerFooter,first.headerFooter])
})

test('isolated slide sections follow the active generation, including reorder and history', async t => {
 const session=await openIsolatedPptxSession({fileId:'f-sections',revision:'r1',bytes:await bytes()},
   {timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>session.close())
 const before=await session.outline(0)
 assert.deepEqual(before.sections,[])
 const added=await session.apply(0,[{op:'addSection',atSlideIndex:1,name:'Second topic'}])
 assert.equal(added.transaction.applied,true)
 assert.deepEqual(added.sections.map(({name,slideIndices})=>({name,slideIndices})),[
  {name:'Default Section',slideIndices:[0]},
  {name:'Second topic',slideIndices:[1]},
 ])
 const moved=await session.apply(added.generation,[{op:'moveSection',id:added.sections[1].id,dir:'up'}])
 assert.deepEqual(moved.paths,[before.paths[1],before.paths[0]])
 assert.deepEqual(moved.sections[0].slideIndices,[0])
 assert.equal(moved.sections[0].name,'Second topic')
 const undone=await session.undo(moved.generation)
 assert.deepEqual(undone.sections,added.sections)
 const redone=await session.redo(undone.generation)
 assert.deepEqual(redone.sections,moved.sections)
 await assert.rejects(()=>session.outline(undone.generation),{message:'GENERATION_CONFLICT'})
 const reopened=await openIsolatedPptxSession({fileId:'f-sections',revision:'r2',bytes:(await session.exportBytes(redone.generation)).bytes},
   {timeoutMs:60000,unsafeTestOnly:true})
 t.after(()=>reopened.close())
 assert.deepEqual((await reopened.outline(0)).sections,moved.sections)
 const deleted=await session.apply(redone.generation,[{op:'removeSectionSlides',id:moved.sections[0].id}])
 assert.equal(deleted.transaction.applied,true)
 assert.deepEqual(deleted.paths,[before.paths[0]])
 assert.deepEqual(deleted.sections,[{...moved.sections[1],slideIndices:[0]}])
 const refused=await session.apply(deleted.generation,[{op:'removeSectionSlides',id:deleted.sections[0].id}])
 assert.equal(refused.transaction.applied,false)
 assert.equal(refused.generation,deleted.generation)
 assert.deepEqual((await session.undo(deleted.generation)).sections,moved.sections)
})
