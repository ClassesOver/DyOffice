import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'

function harness() {
 let release
 const gate=new Promise(resolve=>{release=resolve}), calls=[]
 const native=createXlsxNativeWorker({async run(input,execute){
  await gate
  return execute({async request(command,args){
   calls.push({command,args:structuredClone(args)})
   if(command==='open')return {sessionId:'00000000-0000-4000-8000-000000000000',sheets:[{id:'1',name:'Sheet1'}]}
   if(command==='read_range')return {indexingComplete:true,cells:[]}
   return {cells:[]}
  }})
 }})
 return {native,calls,release}
}
test('read range snapshots validated coordinates before native admission waits',async()=>{
 const h=harness(),range={startRow:0,endRow:0,startColumn:0,endColumn:0}
 const pending=h.native.readRange(Buffer.from('xlsx'),'Sheet1',range)
 range.endRow=1048575;range.endColumn=16383
 h.release();await pending
 assert.deepEqual(h.calls.filter(x=>x.command==='read_range').at(-1).args.range,{startRow:0,endRow:0,startColumn:0,endColumn:0})
})
test('recalculation snapshots edits and nested read ranges before admission waits',async()=>{
 const h=harness(),request={edits:[{sheetName:'Sheet1',row:0,column:0,input:'1'}],reads:[{sheetName:'Sheet1',range:{startRow:0,endRow:0,startColumn:0,endColumn:0}}]}
 const pending=h.native.recalculate(Buffer.from('xlsx'),request)
 request.edits[0].input='changed';request.edits[0].row=1048575
 request.reads[0].range.endRow=1048575
 h.release();await pending
 const actual=h.calls.find(x=>x.command==='recalc_cells').args
 assert.deepEqual(actual.edits,[{sheet:'Sheet1',row:0,column:0,input:'1'}])
 assert.equal(actual.reads[0].range.endRow,0)
})
test('oversized requests are rejected before native admission',async()=>{
 let calls=0
 const native=createXlsxNativeWorker({async run(){calls++;throw Error('must not dispatch')}})
 await assert.rejects(native.readRange(Buffer.from('xlsx'),'Sheet1',{startRow:0,endRow:20000,startColumn:0,endColumn:0}),{code:'INPUT_LIMIT'})
 await assert.rejects(native.recalculate(Buffer.from('xlsx'),{edits:[],reads:[{sheetName:'Sheet1',range:{startRow:0,endRow:20000,startColumn:0,endColumn:0}}]}),{code:'INPUT_LIMIT'})
 assert.equal(calls,0)
})
