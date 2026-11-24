import test from 'node:test'
import JSZip from 'jszip'
import assert from 'node:assert/strict'
import {createApiShell} from '../server/src/framework.ts'
import {registerFileRoutes} from '../server/src/modules/files/routes.ts'

test('authenticated XLSX create route writes a workbook and returns its normal file record',async t=>{
 const app=await createApiShell(),calls=[]
 const files={capabilities:{xlsx:'editable'},stageUpload:async(_token,input)=>{calls.push(['stage',input]);return {uploadId:'upload',fileId:'file'}},receiveUpload:async(_token,id,bytes)=>calls.push(['receive',id,bytes]),finishUpload:async(_token,id)=>{calls.push(['finish',id]);return {file:{fileId:'file'},name:'Report.xlsx',format:'xlsx'}},cancelUpload:async(_token,id)=>calls.push(['cancel',id])}
 registerFileRoutes(app,files,{authenticate:async()=>({})},{originCheck(){},requireSession(){}})
 t.after(()=>app.close());await app.ready()
 const response=await app.inject({method:'POST',url:'/api/v1/ai/xlsx-documents',headers:{cookie:'__Host-dyoffice-session='+'a'.repeat(43)},payload:{title:'Report',sheetName:'Data',content:'Name,Value\nA,4',layout:{defaultRowHeight:18,defaultColumnWidth:12,rows:[[2,39],[8,51]],columns:[[2,28]]}}})
 assert.equal(response.statusCode,200,response.body)
 const zip=await JSZip.loadAsync(calls[1][2]),sheet=await zip.file('xl/worksheets/sheet1.xml').async('string')
 assert.match(sheet,/<col min="2" max="2" width="28" customWidth="1"/)
 assert.match(sheet,/<row r="2" ht="39" customHeight="1">.*>4<\/v>/)
 assert.match(sheet,/<row r="8" ht="51" customHeight="1"/)
 assert.match(sheet,/<sheetFormatPr[^>]*defaultRowHeight="18"/)
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
