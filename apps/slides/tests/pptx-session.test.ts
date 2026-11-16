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

describe('bounded local history and structured selection', () => {
  it('undoes and redoes two native edits with monotonic generations and exact original parts', async () => {
    const {bytes,id}=await fixture(); const s=await createPptxSession(bytes)
    const original=await s.exportBytes(0)
    await s.apply(0,[op(id,'one')]); await s.apply(1,[op(id,'two')])
    expect(await s.undo(2)).toEqual({generation:3})
    expect(await textOf((await s.exportBytes(3)).bytes)).toBe('one')
    await s.undo(3); await expectSameParts((await s.exportBytes(4)).bytes,original.bytes)
    await s.redo(4); await s.redo(5)
    expect(await textOf((await s.exportBytes(6)).bytes)).toBe('two')
    await expect(s.undo(2)).rejects.toThrow('GENERATION_CONFLICT'); s.close()
  })
  it('does not record rejected batches and clears redo after a divergent edit', async () => {
    const {bytes,id}=await fixture(); const s=await createPptxSession(bytes)
    await expect(s.undo(0)).rejects.toThrow('HISTORY_EMPTY')
    await s.apply(0,[op(id,'one')]); await s.undo(1)
    await expect(s.apply(2,[op('missing','bad')])).rejects.toThrow('OP_REJECTED')
    await s.redo(2); await s.undo(3); await s.apply(4,[op(id,'different')])
    await expect(s.redo(5)).rejects.toThrow('HISTORY_EMPTY'); s.close()
  })
  it('returns detached selection identifiers and fences stale/invalid selection', async () => {
    const {bytes,id}=await fixture(); const s=await createPptxSession(bytes)
    const context=await s.selection(0,0,id)
    expect(context.generation).toBe(0); expect(context.slide.index).toBe(0)
    expect(context.element?.id).toBe(id); expect(context.element?.type).toBeTruthy()
    context.slide.index=99
    expect((await s.selection(0,0)).slide.index).toBe(0)
    await expect(s.selection(0,0,'missing')).rejects.toThrow('INVALID_ELEMENT')
    await expect(s.selection(0,99)).rejects.toThrow('INVALID_SLIDE')
    await s.apply(0,[op(id,'next')]); await expect(s.selection(0,0,id)).rejects.toThrow('GENERATION_CONFLICT')
    const pending=s.undo(1); s.close(); await expect(pending).rejects.toThrow('SESSION_CLOSED')
  })
})

it('retains only eight undo points and aborts history calls without changing the model', async () => {
  const {bytes,id}=await fixture(); const s=await createPptxSession(bytes)
  for(let i=0;i<10;i++) await s.apply(i,[op(id,`text${i}`)])
  const c=new AbortController();c.abort()
  await expect(s.undo(10,c.signal)).rejects.toThrow('ABORTED')
  expect(await textOf((await s.exportBytes(10)).bytes)).toBe('text9')
  for(let i=10;i<18;i++) await s.undo(i)
  expect(await textOf((await s.exportBytes(18)).bytes)).toBe('text1')
  await expect(s.undo(18)).rejects.toThrow('HISTORY_EMPTY')
  await s.redo(18)
  expect(await textOf((await s.exportBytes(19)).bytes)).toBe('text2')
  s.close()
})

it('rejects an edit crossing the history byte budget without losing the prior undo point', async () => {
  const {bytes,id}=await fixture()
  const zip=await JSZip.loadAsync(bytes)
  const padding=new Uint8Array(8*1024*1024-20*1024).fill(65)
  for(let i=0;i<8;i++) zip.file(`padding/part${i}.bin`,padding)
  const packed=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})
  const s=await createPptxSession(packed)
  await s.apply(0,[op(id,'small')])
  await expect(s.apply(1,[op(id,'x'.repeat(200000))])).rejects.toThrow('HISTORY_LIMIT')
  expect(await textOf((await s.exportBytes(1)).bytes)).toBe('small')
  await s.undo(1)
  expect(await textOf((await s.exportBytes(2)).bytes)).toBe('original')
  s.close()
}, 60000)

it('fences pre-aborted and closed redo without consuming history', async () => {
  const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
  await s.apply(0,[op(id,'one')]);await s.undo(1)
  const c=new AbortController();c.abort()
  await expect(s.redo(2,c.signal)).rejects.toThrow('ABORTED')
  expect(await textOf((await s.exportBytes(2)).bytes)).toBe('original')
  await s.redo(2);await s.undo(3)
  const redo=s.redo(4);s.close();await expect(redo).rejects.toThrow('SESSION_CLOSED')
})
