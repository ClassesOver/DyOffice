import test from 'node:test'
import assert from 'node:assert/strict'
import {readBackgroundDocument} from '../../server/src/modules/assistant-channel/background-read.ts'
import {backgroundDocumentBytes} from '../helpers/background-documents.mjs'

for(const format of ['docx','xlsx','pptx','pdf'])test('background extracts saved '+format+' bytes in its bounded worker',async()=>{
 const bytes=await backgroundDocumentBytes(format),original=Buffer.from(bytes)
 const result=await readBackgroundDocument(bytes,format,new AbortController().signal)
 assert.match(result.text,/Background budget: 42 CNY/)
 assert.equal(result.truncated,false);assert.deepEqual(bytes,original)
 if(format==='xlsx'){assert.match(result.text,/123/);assert.doesNotMatch(result.text,/do-not-fetch/)}
})
for(const format of ['docx','xlsx','pptx'])test('background '+format+' explicitly reports truncated text',async()=>{
 const bytes=await backgroundDocumentBytes(format,'x'.repeat(25000))
 const result=await readBackgroundDocument(bytes,format,new AbortController().signal)
 assert.equal(result.text.length,24000);assert.equal(result.truncated,true)
})
test('background refuses unsupported formats, malformed bytes, oversized input and cancellation',async()=>{
 await assert.rejects(readBackgroundDocument(Buffer.from('text'),'txt',new AbortController().signal))
 for(const format of ['docx','xlsx','pptx','pdf'])await assert.rejects(readBackgroundDocument(Buffer.from('not a document'),format,new AbortController().signal))
 await assert.rejects(readBackgroundDocument(Buffer.alloc(10*1024*1024+1),'pdf',new AbortController().signal))
 const controller=new AbortController();controller.abort()
 await assert.rejects(readBackgroundDocument(await backgroundDocumentBytes('pdf'),'pdf',controller.signal))
})
test('background reading cancellation terminates an already started worker',async()=>{
 const bytes=await backgroundDocumentBytes('pdf'),controller=new AbortController()
 const result=readBackgroundDocument(bytes,'pdf',controller.signal)
 controller.abort()
 await assert.rejects(result,/cancelled/)
})
