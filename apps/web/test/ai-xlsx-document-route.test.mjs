import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../server/src/framework.ts'
import {registerFileRoutes} from '../server/src/modules/files/routes.ts'

test('authenticated XLSX create route writes a workbook and returns its normal file record',async t=>{
 const app=await createApiShell(),calls=[]
 const files={capabilities:{xlsx:'editable'},stageUpload:async(_token,input)=>{calls.push(['stage',input]);return {uploadId:'upload',fileId:'file'}},receiveUpload:async(_token,id,bytes)=>calls.push(['receive',id,bytes]),finishUpload:async(_token,id)=>{calls.push(['finish',id]);return {file:{fileId:'file'},name:'Report.xlsx',format:'xlsx'}},cancelUpload:async(_token,id)=>calls.push(['cancel',id])}
 registerFileRoutes(app,files,{authenticate:async()=>({})},{originCheck(){},requireSession(){}})
 t.after(()=>app.close());await app.ready()
 const response=await app.inject({method:'POST',url:'/api/v1/ai/xlsx-documents',headers:{cookie:'__Host-dyoffice-session='+'a'.repeat(43)},payload:{title:'Report',sheetName:'Data',content:'Name,Value\nA,4'}})
 assert.equal(response.statusCode,200,response.body)
 assert.deepEqual(response.json(),{file:{fileId:'file'},name:'Report.xlsx',format:'xlsx'})
 assert.deepEqual(calls.map(call=>call.slice(0,2)),[['stage',{name:'Report.xlsx',size:calls[0][1].size}],['receive','upload'],['finish','upload']])
})

test('XLSX create route refuses when the runtime does not advertise XLSX editing',async t=>{
 const app=await createApiShell(),files={capabilities:{xlsx:'unsupported'}}
 registerFileRoutes(app,files,{authenticate:async()=>({})},{originCheck(){},requireSession(){}})
 t.after(()=>app.close());await app.ready()
 const response=await app.inject({method:'POST',url:'/api/v1/ai/xlsx-documents',headers:{cookie:'__Host-dyoffice-session='+'a'.repeat(43)},payload:{title:'Report',content:'A\n1'}})
 assert.equal(response.statusCode,415)
})
