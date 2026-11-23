import test from 'node:test'
import assert from 'node:assert/strict'
import {createWebWorkbookDocumentApi,downloadWebCsv} from '../../src/editors/web-ai-document-api.ts'

test('Web workbook document API routes CSV exports to its authenticated creator and preserves other document types',async()=>{
 const calls=[],base={async createDocument(input){calls.push(['base',input]);return {ok:true,path:'/doc'}}}
 const api=createWebWorkbookDocumentApi(base,async input=>calls.push(['csv',input]))
 assert.deepEqual(await api.createDocument({type:'csv',title:'Sales',content:'Month,Total'}),{ok:true,downloaded:true})
 assert.deepEqual(await api.createDocument({type:'xlsx',title:'Sales',content:'Month,Total'}),{ok:true,path:'/doc'})
 assert.deepEqual(calls,[['csv',{type:'csv',title:'Sales',content:'Month,Total'}],['base',{type:'xlsx',title:'Sales',content:'Month,Total'}]])
})

test('CSV export downloads UTF-8 bytes with a safe filename and releases the object URL',async()=>{
 const calls=[],scheduled=[],url='blob:csv-export';let savedBlob
 const anchor={click(){calls.push('click')},remove(){calls.push('remove')}}
 const platform={document:{createElement(tag){assert.equal(tag,'a');return anchor},body:{append(value){assert.equal(value,anchor);calls.push('append')}}},url:{createObjectURL(blob){savedBlob=blob;calls.push(['blob',blob.type]);return url},revokeObjectURL(value){calls.push(['revoke',value])}},schedule(callback){scheduled.push(callback)}}
 downloadWebCsv({type:'csv',title:'Sales/2026',content:'项目,金额\n收入,42'},platform)
 assert.equal(anchor.download,'Sales_2026.csv');assert.equal(anchor.href,url);assert.equal(anchor.hidden,true)
 assert.equal(await savedBlob.text(),'项目,金额\n收入,42')
 assert.deepEqual(calls,[['blob','text/csv;charset=utf-8'],'append','click','remove'])
 assert.equal(scheduled.length,1);scheduled[0]();assert.deepEqual(calls.at(-1),['revoke',url])
})


test('native workbook CSV export warns about loss before downloading the current sheet',async()=>{
 const calls=[],warnings=[]
 const api=createWebWorkbookDocumentApi({async createDocument(){throw Error('not used')},async exportCsv(){throw Error('This operation is unavailable in the Web editor.')}},async input=>calls.push(input),{language:'en',confirmCsvExport:message=>{warnings.push(message);return true},chooseCsvExport:async(message)=>{warnings.push(message);return 'csv'}})
 assert.deepEqual(await api.exportCsv({fileName:'Sales.csv',content:'Amount\n42',hasFormulas:true,activeSheetName:'Revenue'}),{canceled:false,path:'Sales.csv'})
 assert.deepEqual(calls,[{type:'csv',title:'Sales',content:'\uFEFFAmount\n42'}])
 assert.match(warnings[0],/formatting/i)
 assert.match(warnings[0],/formulas.*values/i)
 assert.match(warnings[0],/Revenue/)
})

test('native workbook CSV export can reroute formula exports to Save As XLSX',async()=>{
 const api=createWebWorkbookDocumentApi({async createDocument(){throw Error('not used')},async exportCsv(){throw Error('not used')}},async()=>{throw Error('CSV should not download')},{chooseCsvExport:async()=> 'xlsx'})
 assert.deepEqual(await api.exportCsv({fileName:'Sales.csv',content:'Amount\n42',hasFormulas:true}),{canceled:true,saveAsXlsxInstead:true})
})

test('native workbook CSV export cancellation and desktop paths never download',async()=>{
 const calls=[]
 const api=createWebWorkbookDocumentApi({async createDocument(){throw Error('not used')},async exportCsv(){throw Error('This operation is unavailable in the Web editor.')}},async input=>calls.push(input),{language:'zh',confirmCsvExport:message=>{assert.match(message,/格式/);return false}})
 assert.deepEqual(await api.exportCsv({fileName:'Sales.csv',content:'Amount\n42',hasFormulas:false}),{canceled:true})
 await assert.rejects(()=>api.exportCsv({fileName:'Sales.csv',content:'Amount\n42',hasFormulas:false,targetPath:'/tmp/sales.csv'}),/path|路径/i)
 assert.deepEqual(calls,[])
})

test('native CSV export reports a safe filename and propagates failed downloads',async()=>{
 const api=createWebWorkbookDocumentApi({async createDocument(){throw Error('not used')}},async()=>{}, {confirmCsvExport:()=>true})
 assert.deepEqual(await api.exportCsv({fileName:'Sales/2026.CSV',content:'项目,42',hasFormulas:false}),{canceled:false,path:'Sales_2026.csv'})
 const failed=createWebWorkbookDocumentApi({async createDocument(){throw Error('not used')}},async()=>{throw Error('download failed')},{confirmCsvExport:()=>true})
 await assert.rejects(()=>failed.exportCsv({fileName:'Sales.csv',content:'42',hasFormulas:false}),/download failed/)
})
