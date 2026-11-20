import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {createPdfOcr} from '../../server/src/pdf/ocr.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {registerPdfRoutes} from '../../server/src/modules/pdf/routes.ts'

const scan = new URL('../../../../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png', import.meta.url)

test('recognizes raster text with PDF-oriented boxes using the installed engine', {
  skip: process.env.DYOFFICE_TEST_PDF_OCR !== '1',
}, async () => {
  const lines = await createPdfOcr()((await readFile(scan)).toString('base64'))
  const title = lines.find(line => /OCR Smoke Fixture/.test(line.text))
  assert.ok(title)
  assert.deepEqual(title.chars.filter(word => word.text !== ' ').map(word => word.text), ['OCR', 'Smoke', 'Fixture'])
  const [left, bottom, right, top] = title.box
  assert.ok(left > 0.10 && left < 0.13 && right > 0.40 && right < 0.43)
  assert.ok(bottom > 0.69 && bottom < 0.73 && top > 0.76 && top < 0.79)
})

test('rejects non-PNG data and images exceeding the OCR pixel budget', async () => {
  const recognize = createPdfOcr()
  await assert.rejects(recognize(Buffer.from('%PDF-1.7').toString('base64')), {message: 'INVALID_IMAGE'})
  const png = await readFile(scan)
  png.writeUInt32BE(100000, 16)
  await assert.rejects(recognize(png.toString('base64')), {message: 'INVALID_IMAGE'})
})

test('PDF OCR route requires CSRF and an authorized current PDF revision', async t => {
  const app = Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}})
  t.after(()=>app.close())
  const token='a'.repeat(43), id=randomUUID(), revision=randomUUID()
  const denied=()=>Object.assign(Error('Forbidden'),{statusCode:403})
  const service=createPdfService({leases:{},revisions:{},files:{async openFile(session,fileId){
    if(session!==token||fileId!==id)throw denied()
    return {file:{revision},format:'pdf'}
  }}})
  registerPdfRoutes(app,service,{authenticate:async session=>{if(session!==token)throw denied()}},{
    originCheck(){},requireSession(req,session){if(req.headers['x-csrf-token']!==session)throw denied()},
  })
  const png='?'.repeat(44)
  const url=`/api/v1/files/${id}/pdf/ocr`,headers={cookie:`__Host-dyoffice-session=${token}`,'x-csrf-token':token}
  const post=(payload,options={})=>app.inject({method:'POST',url,headers,payload,...options})
  assert.equal((await post({revision,png},{headers:{cookie:headers.cookie}})).statusCode,403)
  assert.equal((await post({revision,png},{url:`/api/v1/files/${randomUUID()}/pdf/ocr`})).statusCode,403)
  assert.equal((await post({revision:randomUUID(),png})).statusCode,409)
  assert.equal((await post({revision,png,command:'other'})).statusCode,400)
  assert.equal((await post({revision,png})).statusCode,400)
})
