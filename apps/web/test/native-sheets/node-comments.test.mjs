import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import JSZip from 'jszip'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'

test('Node XLSX keeps existing notes and comment threads when a new note is saved',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-node-xlsx-comments-'))
 let runtime
 t.after(async()=>{await runtime?.close();await rm(directory,{recursive:true,force:true})})
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:randomUUID(),
  DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),
  DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
 },{enabled:true})
 const native=runtime.sheetsNative
 const source=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))

 async function saveNotes(bytes,notes){
  const request=sheetsSaveRequest('sheet-1',[])
  request.noteStates=[{sheetId:'sheet-1',notes}]
  const plan=await runtime.sheetsWorkbookPlanner(bytes,request)
  return (await native.savePlan(bytes,plan)).bytes
 }
 const legacy={row:1,column:0,author:'Audit & review',text:'Existing note <A2>\nSecond line'}
 const reply={id:'{33333333-3333-3333-3333-333333333333}',personId:'{44444444-4444-4444-4444-444444444444}',
  author:'Grace',dT:'2026-09-02T08:30:00',text:'Reply for A4'}
 const thread={id:'{11111111-1111-1111-1111-111111111111}',personId:'{22222222-2222-2222-2222-222222222222}',
  author:'Ada',dT:'2026-09-01T08:30:00',done:true,replies:[reply]}
 const modern={row:3,column:0,author:'Ada',text:'Root for A4',thread}
 const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
 const picture={mediaType:'image/png',base64,widthPx:1,heightPx:1,name:'Note.png'}
 const input=await saveNotes(source,[{...legacy,picture},modern])
 const inspect=async bytes=>(await native.inspect(bytes)).sheets[0].comments
 const imported=await inspect(input)
 const image=imported[0]?.image
 assert.match(image?.id??'',/^image\d+\.png$/)
 const importedLegacy={...legacy,image}
 const importedModern={...modern,text:'Root for A4\n\nReply for A4',thread:{...thread,text:'Root for A4'}}
 assert.deepEqual(imported,[importedLegacy,importedModern])
 assert.deepEqual(await native.readMedia(input,image.id),{mediaType:'image/png',base64})

 // The editor's save supplies every remaining note, preserving the root and
 // replies separately from the text displayed next to the cell.
 const snapshot=imported.map(({thread,image:_image,...entry})=>{
  if(!thread)return entry
  const {text,...identity}=thread
  return {...entry,text,thread:identity}
 })
 const added={row:2,column:0,author:'',text:'New note on A3'}
 const saved=await saveNotes(input,[...snapshot,added])
 assert.deepEqual((await inspect(saved)).toSorted((a,b)=>a.row-b.row),[importedLegacy,added,importedModern])
 assert.deepEqual(await native.readMedia(saved,image.id),{mediaType:'image/png',base64})
 const threadPath='xl/threadedComments/threadedComment1.xml'
 const before=await JSZip.loadAsync(input),after=await JSZip.loadAsync(saved)
 assert.equal(await after.file(threadPath).async('string'),await before.file(threadPath).async('string'))

 const deleted=await saveNotes(saved,[modern,added])
 assert.deepEqual((await inspect(deleted)).toSorted((a,b)=>a.row-b.row),[added,importedModern])

 await t.test('edits a thread in place with single-quoted package relationships',async()=>{
  const seeded=await JSZip.loadAsync(input)
  const sheetRels='xl/worksheets/_rels/sheet1.xml.rels',workbookRels='xl/_rels/workbook.xml.rels'
  const quoteRelationship=(xml,kind)=>xml.replace(/<Relationship\b[^>]*\/>/g,tag=>
   tag.includes('/'+kind+'"')?tag.replace(/(Type|Target)="([^"]*)"/g,"$1='$2'"):tag)
  seeded.file(sheetRels,quoteRelationship(await seeded.file(sheetRels).async('string'),'threadedComment'))
  const originalPersons='xl/persons/person.xml',movedPersons='xl/persons/team.xml'
  seeded.file(movedPersons,await seeded.file(originalPersons).async('string'))
  seeded.remove(originalPersons)
  const workbookXml=await seeded.file(workbookRels).async('string')
  seeded.file(workbookRels,quoteRelationship(workbookXml.replace('persons/person.xml','persons/team.xml'),'person'))
  const types='[Content_Types].xml'
  seeded.file(types,(await seeded.file(types).async('string')).replace(originalPersons,movedPersons))
  const seededBytes=await seeded.generateAsync({type:'nodebuffer'})
  assert.equal((await inspect(seededBytes))[1].thread.author,'Ada')
  const revised={...modern,text:'Edited threaded root'}
  const result=await saveNotes(seededBytes,[legacy,revised])
  const output=await JSZip.loadAsync(result)
  assert.deepEqual(output.file(/^xl\/threadedComments\/threadedComment\d+\.xml$/).map(part=>part.name),[threadPath])
  assert.equal(output.file(originalPersons),null)
  assert.equal((await inspect(result))[1].thread.text,'Edited threaded root')
 })

 await t.test('reads and saves prefixed threaded comment and person parts',async()=>{
  const book=await JSZip.loadAsync(input)
  const personsPath='xl/persons/person.xml'
  for(const path of [threadPath,personsPath]){
   const xml=await book.file(path).async('string')
   book.file(path,xml.replace(/<(\/?)(ThreadedComments|threadedComment|text|personList|person)(?=[\s/>])/g,'<$1tc:$2')
    .replace(' xmlns=',' xmlns:tc='))
  }
  const prefixed=await book.generateAsync({type:'nodebuffer'})
  assert.deepEqual(await inspect(prefixed),[importedLegacy,importedModern])
  const edited={...modern,text:'Edited prefixed root'}
  const newThread={...thread,id:'{55555555-5555-5555-5555-555555555555}',
   personId:'{66666666-6666-6666-6666-666666666666}',author:'Lin',replies:[]}
  const result=await saveNotes(prefixed,[legacy,edited,{row:4,column:0,author:'Lin',text:'New prefixed thread',thread:newThread}])
  const comments=await inspect(result)
  assert.equal(comments[1].thread.text,'Edited prefixed root')
  assert.deepEqual(comments[1].thread.replies,[reply])
  assert.equal(comments[2].thread.author,'Lin')
  const output=await JSZip.loadAsync(result)
  assert.match(await output.file(threadPath).async('string'),/<tc:threadedComment ref="A5"/)
  assert.match(await output.file(personsPath).async('string'),/<tc:person displayName="Lin"/)
 })

 await t.test('unsupported thread metadata remains in the package when another note is added',async()=>{
  const altered=await JSZip.loadAsync(deleted)
  const threads=(await altered.file(threadPath).async('string')).replace(thread.dT,'x'.repeat(41))
  altered.file(threadPath,threads)
  // Excel can store a thread without its optional compatibility mirror.
  const comments=altered.file(/^xl\/comments\d+\.xml$/)[0]
  altered.file(comments.name,(await comments.async('string')).replace(/<comment ref="A4"[\s\S]*?<\/comment>/,''))
  const alteredBytes=await altered.generateAsync({type:'nodebuffer'})
  const displayed=await inspect(alteredBytes)
  assert.deepEqual(displayed,[added,{row:3,column:0,author:'Ada',text:'Root for A4\n\nReply for A4'}])
  const newNote={row:4,column:0,author:'',text:'New note on A5'}
  const repacked=await JSZip.loadAsync(await saveNotes(alteredBytes,[...displayed,newNote]))
  assert.equal(await repacked.file(threadPath).async('string'),threads)
 })
})
