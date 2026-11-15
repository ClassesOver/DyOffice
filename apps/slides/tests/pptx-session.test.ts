// @vitest-environment node
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {elementDurableId} from '@genoffice/pptx-ops'
import { addElement, createBlankPptx, openPptx, savePptx } from '@genoffice/pptx-engine'
import { createPptxSession } from '../../web/worker/src/native/pptx-session'
async function fixture() {
  const opened = await openPptx(await createBlankPptx())
  addElement(opened.deck.slides[0]!, {kind:'textbox',offset:{x:0,y:0,cx:1828800,cy:914400},paragraphs:[{runs:[{text:'original'}]}]})
  const bytes=await savePptx(opened)
  const reopened=await openPptx(bytes)
  return {bytes,id:elementDurableId(reopened.deck.slides[0]!.elements.find(e=>e.type==='text'||e.type==='shape')!)!}
}

async function expectSameParts(left: Uint8Array, right: Uint8Array) {
  const a = await JSZip.loadAsync(left), b = await JSZip.loadAsync(right)
  const names = Object.keys(a.files).filter(name => !a.files[name]!.dir).sort()
  expect(Object.keys(b.files).filter(name => !b.files[name]!.dir).sort()).toEqual(names)
  for (const name of names) expect(await a.files[name]!.async('uint8array'), name).toEqual(await b.files[name]!.async('uint8array'))
}

const op = (id:string, text:string) => ({op:'setText',target:{slide:0,el:id},paragraphs:[{runs:[{text}]}]})
async function textOf(bytes:Uint8Array) {
  const opened=await openPptx(bytes)
  const el=opened.deck.slides[0]!.elements.find(e=>e.type==='text'||e.type==='shape')
  return el && 'text' in el ? el.text?.paragraphs.map(p=>p.runs.map(r=>r.text).join('')).join('\n') : ''
}
describe('transport-free PPTX session, local generation only', () => {
  it('edits native bytes and exports the captured generation before the next queued edit', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    expect(await s.apply(0,[op(id,'first')])).toEqual({generation:1})
    const saving=s.exportBytes(1)
    const editing=s.apply(1,[op(id,'second')])
    const saved=await saving;await editing
    expect(saved.generation).toBe(1);expect(await textOf(saved.bytes)).toBe('first')
    expect(await textOf((await s.exportBytes(2)).bytes)).toBe('second')
    expect(JSON.stringify(await s.render(2,0))).toContain('second')
    s.close()
  })
  it('rejects stale concurrent edits and recovers the serial queue', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    const results=await Promise.allSettled([s.apply(0,[op(id,'one')]),s.apply(0,[op(id,'two')])])
    expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected'])
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('GENERATION_CONFLICT')
    await expect(s.apply(1,[op(id,'three')])).resolves.toEqual({generation:2})
    s.close()
  })
  it('rejects a bad native batch without changing generation or package parts', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    const before=await s.exportBytes(0)
    await expect(s.apply(0,[op(id,'not saved'),{...op('missing','bad'),target:{slide:999,el:'missing'}}])).rejects.toThrow('OP_REJECTED')
    await expectSameParts((await s.exportBytes(0)).bytes, before.bytes)
    await expect(s.apply(0,[{op:'removeSlide',target:{slide:0}}])).rejects.toThrow('UNSUPPORTED_OP')
    s.close()
  })
  it('captures command payloads before queueing and returns detached render data', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    const ops=[op(id,'captured')];const edit=s.apply(0,ops);ops[0]!.paragraphs[0]!.runs[0]!.text='mutated'
    await edit
    const render=await s.render(1,0);render.widthPx=17
    expect((await s.render(1,0)).widthPx).toBe(960)
    expect(await textOf((await s.exportBytes(1)).bytes)).toBe('captured')
    s.close()
  })
  it('closes synchronously, rejects pending work, and honors pre-aborted calls', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    const c=new AbortController();c.abort()
    await expect(s.apply(0,[op(id,'abort')],c.signal)).rejects.toThrow('ABORTED')
    const pending=s.apply(0,[op(id,'closed')]);s.close();s.close()
    await expect(pending).rejects.toThrow('SESSION_CLOSED')
    await expect(s.exportBytes(0)).rejects.toThrow('SESSION_CLOSED')
    await expect(createPptxSession(bytes,c.signal)).rejects.toThrow('ABORTED')
  })
  it('rejects an export aborted while compression is pending without advancing generation', async () => {
    const {bytes}=await fixture();const s=await createPptxSession(bytes)
    const c=new AbortController();const exporting=s.exportBytes(0,c.signal)
    await Promise.resolve();c.abort()
    await expect(exporting).rejects.toThrow('ABORTED')
    expect((await s.exportBytes(0)).generation).toBe(0);s.close()
  })
  it('copies input bytes before opening and blocks master paths and injected fields', async () => {
    const {bytes,id}=await fixture();const pending=createPptxSession(bytes);bytes.fill(0)
    const s=await pending
    await expect(s.apply(0,[{...op(id,'x'),target:{slide:0,el:id,part:'ppt/slideMasters/slideMaster1.xml'}}])).rejects.toThrow('UNSUPPORTED_FIELD')
    await expect(s.apply(0,[{...op(id,'x'),isolation:'per_op'}])).rejects.toThrow('UNSUPPORTED_FIELD')
    const {generation}=await s.apply(0,[op(id,'copied')]);expect(generation).toBe(1)
    const exporting=s.exportBytes(1);s.close()
    await expect(exporting).rejects.toThrow('SESSION_CLOSED')
  })
  it('applies Web inflation budgets before native parsing', async () => {
    const zip=new JSZip();zip.file('oversized.bin',new Uint8Array(8*1024*1024+1))
    const bytes=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})
    await expect(createPptxSession(bytes)).rejects.toThrow(/zip rejected.*part/)
  })
  it('bounds source bytes, operations, payload and queue without poisoning the session', async () => {
    await expect(createPptxSession(new Uint8Array(32*1024*1024+1))).rejects.toThrow('INPUT_LIMIT')
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    await expect(s.apply(0,Array.from({length:101},()=>op(id,'x')))).rejects.toThrow('OPS_LIMIT')
    await expect(s.apply(0,[op(id,'x'.repeat(256*1024))])).rejects.toThrow('PAYLOAD_LIMIT')
    const calls=Array.from({length:33},()=>s.render(0,0))
    expect((await Promise.allSettled(calls)).filter(r=>r.status==='rejected')).toHaveLength(1)
    await expect(s.apply(0,[op(id,'ok')])).resolves.toEqual({generation:1});s.close()
  })
})
