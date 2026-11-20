import Fastify from 'fastify'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSheetsService} from '../../server/src/modules/sheets/service.ts'
import {registerSheetsRoutes} from '../../server/src/modules/sheets/routes.ts'

test('merge source routes accept an authenticated binary workbook and stream ranges',async t=>{
 const app=Fastify({logger:false}),token='a'.repeat(43),fileId='74ad6054-8061-44ef-b42c-ef55e5bf851d',revision='4746fb72-4380-4d28-9802-86fa3b462807'
 t.after(()=>app.close())
 const files={async openFile(actual,id){assert.equal(actual,token);assert.equal(id,fileId);return {format:'xlsx',file:{revision}}}}
 const native={
  async inspect(input){assert.equal(input.toString(),'xlsx-bytes');return {entryCount:1,sheets:[{id:'s1',name:'Sheet1',rowCount:1,columnCount:1}],styles:[],dxfStyles:[],visuals:[],definedNames:[]}},
  async readRange(input,sheetName,range){assert.equal(input.toString(),'xlsx-bytes');assert.equal(sheetName,'Sheet1');return {cells:[],range}},
 }
 registerSheetsRoutes(app,createSheetsService({files,native}),{authenticate:async()=>({})},{originCheck(){},requireSession() {}})
 await app.ready()
 const headers={cookie:`__Host-dyoffice-session=${token}`,origin:'http://localhost', 'x-csrf-token':token}
 const opened=await app.inject({method:'POST',url:`/api/v1/files/${fileId}/sheets/merge-sources/open?revision=${revision}&name=source.xlsx`,headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.from('xlsx-bytes')})
 assert.equal(opened.statusCode,200,opened.body)
 assert.equal(opened.headers['cache-control'],'private, no-store')
 const sessionId=opened.json().sessionId
 const range=await app.inject({method:'POST',url:`/api/v1/files/${fileId}/sheets/merge-sources/range`,headers,payload:{revision,sessionId,sheetName:'Sheet1',range:{startRow:0,endRow:0,startColumn:0,endColumn:0}}})
 assert.equal(range.statusCode,200,range.body)
 assert.deepEqual(range.json().range,{startRow:0,endRow:0,startColumn:0,endColumn:0})
 const closed=await app.inject({method:'POST',url:`/api/v1/files/${fileId}/sheets/merge-sources/close`,headers,payload:{revision,sessionId}})
 assert.equal(closed.statusCode,200,closed.body)
})
