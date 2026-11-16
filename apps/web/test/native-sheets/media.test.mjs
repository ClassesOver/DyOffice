import {fileFixture,importFile} from '../helpers/files.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import JSZip from 'jszip'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
test('native media reads owned workbook visual bytes without accepting a path',async t=>{
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')
 let drawing=await zip.file('xl/drawings/drawing1.xml').async('string')
 drawing=drawing.replace(/<xdr:graphicFrame[\s\S]*?<\/xdr:graphicFrame>/,'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Pixel"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>')
 zip.file('xl/drawings/drawing1.xml',drawing)
 zip.file('xl/drawings/_rels/drawing1.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>')
 zip.file('xl/media/image1.png',png)
 const types=await zip.file('[Content_Types].xml').async('string');zip.file('[Content_Types].xml',types.replace('</Types>','<Default Extension="png" ContentType="image/png"/></Types>'))
 const bytes=await zip.generateAsync({type:'nodebuffer'}),native=createXlsxNativeWorker(await sandboxFixture('native'))
 const file=await native.inspect(bytes),visual=file.visuals.find(v=>v.kind==='image')
 assert.ok(visual)
 const result=await native.readMedia(bytes,visual.id)
 assert.equal(result.mediaType,'image/png');assert.deepEqual(Buffer.from(result.base64,'base64'),png)
 await assert.rejects(()=>native.readMedia(bytes,'/etc/passwd'))
 const f=await fileFixture(t,{sheetsNative:native}),owned=(await importFile(f,f.alice.token,bytes,'image.xlsx')).file
 const origin='https://office.example',csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const headers=token=>({cookie:'__Host-dyoffice-session='+token,origin,'x-csrf-token':csrf.sessionToken(token)})
 const url='/api/v1/files/'+owned.fileId+'/sheets/media',payload={revision:owned.revision,visualId:visual.id}
 const response=await f.app.inject({method:'POST',url,headers:headers(f.alice.token),payload})
 assert.equal(response.statusCode,200,response.body);assert.deepEqual(Buffer.from(response.json().base64,'base64'),png)
 for(const token of [f.bob.token,f.adminSigned.token])assert.equal((await f.app.inject({method:'POST',url,headers:headers(token),payload})).statusCode,404)
 assert.equal((await f.app.inject({method:'POST',url,headers:headers(f.alice.token),payload:{...payload,visualId:'/etc/passwd'}})).statusCode,400)
 assert.equal((await f.app.inject({method:'POST',url,headers:{cookie:headers(f.alice.token).cookie,origin},payload})).statusCode,403)

})
