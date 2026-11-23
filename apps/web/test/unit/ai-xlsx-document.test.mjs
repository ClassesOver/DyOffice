import {test} from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {createAiXlsxDocument} from '../../server/src/modules/sheets/create-document.ts'

test('AI XLSX creation stores a real workbook through the normal upload lifecycle', async () => {
  const calls=[]
  const files={
    async stageUpload(_token,input){calls.push(['stage',input]);return {uploadId:'upload-id',fileId:'file-id'}},
    async receiveUpload(_token,id,bytes){calls.push(['receive',id,bytes])},
    async finishUpload(_token,id){calls.push(['finish',id]);return {file:{fileId:'file-id'},name:'Quarterly report.xlsx',format:'xlsx'}},
    async cancelUpload(_token,id){calls.push(['cancel',id])},
  }
  const result=await createAiXlsxDocument(files,'session',{title:'Quarterly report',sheetName:'Results',content:'Name,Value\nRevenue,42'})
  assert.equal(result.file.fileId,'file-id')
  assert.deepEqual(calls.map(call=>call.slice(0,2)),[
    ['stage',{name:'Quarterly report.xlsx',size:calls[0][1].size}],
    ['receive','upload-id'],
    ['finish','upload-id'],
  ])
  const zip=await JSZip.loadAsync(calls[1][2])
  assert.match(await zip.file('xl/workbook.xml').async('string'),/Results/)
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'),/Revenue/)
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'),/>42</)
})

test('AI XLSX creation cancels an uncommitted upload when storage fails', async () => {
  const calls=[]
  const files={
    async stageUpload(){return {uploadId:'upload-id',fileId:'file-id'}},
    async receiveUpload(){throw new Error('storage unavailable')},
    async finishUpload(){throw new Error('must not finish')},
    async cancelUpload(_token,id){calls.push(id)},
  }
  await assert.rejects(createAiXlsxDocument(files,'session',{title:'Report',content:'A\n1'}),/storage unavailable/)
  assert.deepEqual(calls,['upload-id'])
})
