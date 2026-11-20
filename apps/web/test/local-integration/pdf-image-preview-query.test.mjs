import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,rgb} from 'pdf-lib'
import {PNG} from 'pngjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService,SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'

test('PDF image preview is read-only, revision-bound and refuses ambiguous targets',async t=>{
 const f=await fileFixture(t),doc=await PDFDocument.create(),page=doc.addPage([300,240])
 const pixels=new PNG({width:8,height:8})
 for(let i=0;i<64;i++)pixels.data.set([64,32,128,128],i*4)
 const image=await doc.embedPng(PNG.sync.write(pixels))
 page.drawRectangle({x:24,y:40,width:50,height:50,color:rgb(1,0,0)})
 page.drawImage(image,{x:24,y:40,width:40,height:40})
 for(let i=0;i<2;i++)page.drawImage(image,{x:120,y:40,width:40,height:40})
 const original=Buffer.from(await doc.save())
 const {file}=await importFile(f,f.alice.token,original,'image-preview.pdf')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const query=(token,operation,revision=file.revision)=>f.app.inject({method:'POST',url:`/api/v1/files/${file.fileId}/pdf/image-previews/query`,
  payload:{revision,operation},headers:{origin:restrictedOrigin,cookie:SESSION_COOKIE+'='+token,'x-csrf-token':csrf.sessionToken(token)}})
 const list={kind:'list'},source={kind:'source',pageIndex:0,rect:[24,40,64,80],scale:1}
 const erase={kind:'erase',pageIndex:0,excludeRects:[source.rect],clip:{x:24,y:160,width:40,height:40},pxWidth:40,rotate:0}
 assert.equal((await query(f.bob.token,list)).statusCode,404)
 assert.equal((await query(f.alice.token,list,randomUUID())).statusCode,409)
 assert.equal((await query(f.alice.token,{...source,rect:[120,40,160,80]})).statusCode,400)
 assert.equal((await query(f.alice.token,{...erase,clip:{...erase.clip,height:3000}})).statusCode,400)
 const flip={op:'flip_image',page:1,image_number:1,axis:'horizontal'}
 assert.equal((await query(f.alice.token,{...erase,imageBakes:[flip]})).statusCode,400)
 assert.equal((await query(f.alice.token,{...erase,imageBakes:[{...flip,page:2}]})).statusCode,400)
 assert.equal((await query(f.alice.token,{...erase,imageBakes:[flip,flip]})).statusCode,400)
 const read=async op=>{const reply=await query(f.alice.token,op);assert.equal(reply.statusCode,200,reply.body);return reply.json().result}
 assert.deepEqual(await read(list),[{pageIndex:0,rect:source.rect,aboveText:false}])
 const getPixel=base64=>[...PNG.sync.read(Buffer.from(base64,'base64')).data.subarray(0,4)]
 const rendered=await read(source)
 const pixel=getPixel(rendered)
 assert.ok(pixel.every((value,i)=>Math.abs(value-[64,32,128,128][i])<=2),JSON.stringify(pixel))
 assert.deepEqual(getPixel((await read(erase)).png),[255,0,0,255])
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})
