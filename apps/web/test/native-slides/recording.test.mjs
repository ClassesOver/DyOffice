import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {encodeWav} from '../../../slides/src/renderer/narration/wav.ts'

const source=()=>readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
const open=(bytes,revision='r1')=>openIsolatedPptxSession({fileId:'narration',revision,bytes},
 {timeoutMs:60000,unsafeTestOnly:true})
const wav=encodeWav(new Float32Array(2400).fill(.25),24000)
const take={slideIndex:0,bytes:wav,durationMs:100,advanceMs:1200}

test('isolated PPTX saves playable narration atomically and clears it in one undo step',async t=>{
 const session=await open(await source())
 t.after(()=>session.close())
 assert.equal(await session.mediaData(0,0,'unknown'),null)
 await assert.rejects(()=>session.applyRecording(0,{kind:'save',slides:[take,{...take,slideIndex:1,bytes:new Uint8Array(64)}]}),{message:'INVALID_MEDIA'})
 assert.equal((await session.render(0,0)).nodes.filter(node=>node.media).length,0)
 const saved=await session.applyRecording(0,{kind:'save',slides:[take]})
 assert.equal(saved.generation,1)
 assert.deepEqual(saved.records.map(({op})=>op.op),['addNarration','setAdvanceTime'])
 const node=(await session.render(1,0)).nodes.find(node=>node.media)
 assert.ok(node)
 assert.deepEqual((await session.slideInfo(1))[0].timing.narrationIds,[node.sourceId])
 assert.ok((await session.animations(1,0)).some(item=>item.effect==='mediaPlay'&&item.sourceId===node.sourceId))
 const media={kind:'audio',dataUrl:'data:audio/wav;base64,'+Buffer.from(wav).toString('base64')}
 assert.deepEqual(await session.mediaData(1,0,node.sourceId),media)
 assert.equal(await session.mediaData(1,1,node.sourceId),null)
 const reopened=await open((await session.exportBytes(1)).bytes,'r2')
 t.after(()=>reopened.close())
 const reopenedNode=(await reopened.render(0,0)).nodes.find(node=>node.media)
 assert.deepEqual(await reopened.mediaData(0,0,reopenedNode.sourceId),media)
 assert.equal(await session.applyRecording(1,{kind:'clear',indexes:[1]}),null)
 const cleared=await session.applyRecording(1,{kind:'clear',indexes:[0,1]})
 assert.equal(cleared.generation,2)
 assert.equal(await session.mediaData(2,0,node.sourceId),null)
 const restored=await session.undo(2)
 assert.deepEqual(await session.mediaData(restored.generation,0,node.sourceId),media)
})
