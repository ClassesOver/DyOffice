import test from 'node:test'
import assert from 'node:assert/strict'
import {createWorkspaceWorkbookPicker} from '../../src/editors/workbook-tab-picker.ts'

test('only the linked workspace tab can return a validated range to the editing tab',async()=>{
 const document={},activated=[]
 const register=createWorkspaceWorkbookPicker({document},id=>activated.push(id))
 const mount=id=>{
  const frame={isConnected:true,ownerDocument:document,dataset:{documentId:id},dyofficeDraftCopySessionActive:()=>true}
  const caller={frameElement:frame}
  frame.contentWindow=caller
  return {caller,frame,picker:register(caller,id,()=>true)}
 }
 const source=mount('source'),target=mount('target'),other=mount('other')
 assert.equal(register(source.caller,'target',()=>true),undefined)
 const found=source.picker.list().find(item=>item.id==='target')
 assert.ok(found)
 const arms=[],results=[],cancellations=[]
 target.picker.onArmed(value=>arms.push(value))
 source.picker.onSelected(value=>results.push(value))
 source.picker.onCancelled(value=>cancellations.push(value))
 const {pickId}=await source.picker.arm(found.wcId)
 assert.deepEqual(arms,[{pickId}])
 assert.deepEqual(activated,['target'])
 const range={pickId,sheetName:'Catalog',startRow:1,endRow:3,startColumn:2,endColumn:2}
 await other.picker.send(range)
 await target.picker.send({...range,startRow:-1})
 await other.picker.cancel(pickId)
 assert.deepEqual(results,[])
 await target.picker.send(range)
 await target.picker.send(range)
 assert.deepEqual(results,[range])
 assert.deepEqual(activated,['target','source'])
 const next=await source.picker.arm(found.wcId)
 target.frame.isConnected=false
 target.picker.dispose()
 assert.deepEqual(cancellations,[next])
 assert.ok(source.picker.list().every(item=>item.id!=='target'))
 await assert.rejects(source.picker.arm(found.wcId),/unavailable/)
})
