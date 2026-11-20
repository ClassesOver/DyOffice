// @vitest-environment node
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {createHash} from 'node:crypto'
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
  const el=opened.deck.slides[0]?.elements.find(e=>e.type==='text'||e.type==='shape')
  return el && 'text' in el ? el.text?.paragraphs.map(p=>p.runs.map(r=>r.text).join('')).join('\n') : ''
}
describe('transport-free PPTX session, local generation only', () => {
  it('edits native bytes and exports the captured generation before the next queued edit', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    expect((await s.apply(0,[op(id,'first')])).generation).toBe(1)
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
    await expect(s.apply(1,[op(id,'three')])).resolves.toMatchObject({generation:2})
    s.close()
  })
  it('rejects a bad native batch without changing generation or package parts', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    const before=await s.exportBytes(0)
    const rejected=await s.apply(0,[{op:'deleteElement',target:{slide:0,el:id}},op(id,'not saved')])
    expect(rejected).toMatchObject({
      generation:0,stateGeneration:0,canUndo:false,canRedo:false,
      transaction:{applied:false,failures:[{index:1,error:expect.stringContaining('no element')}]},
    })
    expect(rejected.records).toEqual([])
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
    await expect(s.apply(0,[op(id,'ok')])).resolves.toMatchObject({generation:1});s.close()
  })
})
describe('T10 op whitelist: slide lifecycle, element add/delete/transform, fill/stroke/text', () => {
  it('adds, transforms, fills, strokes and deletes elements, reporting created ids', async () => {
    const {bytes}=await fixture();const s=await createPptxSession(bytes)
    const added=await s.apply(0,[{op:'addElement',target:{slide:0},kind:'roundRect',offset:{x:914400,y:914400,cx:1828800,cy:914400},fill:'#204060',stroke:{color:'#102030',widthEmu:12700}}])
    expect(added.records[0]!.created?.[0]).toBeTruthy()
    const shape=added.records[0]!.created![0]!
    // Bridge contract: add ops echo created entries with the located slide and element.
    expect(added.created).toEqual([{slide:0,index:1,id:shape}])
    const textbox=await s.apply(1,[{op:'addElement',target:{slide:0},kind:'textbox',offset:{x:914400,y:2743200,cx:1828800,cy:914400},paragraphs:[{runs:[{text:'typed'}]}]}])
    expect(textbox.created![0]!.slide).toBe(0)
    expect(typeof textbox.created![0]!.index).toBe('number')
    await expect(s.apply(2,[{op:'setNotes',target:{slide:0},text:'speaker notes'}])).resolves.toMatchObject({generation:3})
    await expect(s.apply(3,[{op:'setNotes',target:{slide:0},text:'x'.repeat(65537)}])).rejects.toThrow('INVALID_TEXT')
    await expect(s.apply(3,[{op:'setNotes',target:{slide:0},text:5}])).rejects.toThrow('INVALID_TEXT')
    // Notes edits survive the save pipeline (the notes part is written, not dropped).
    const exported=await s.exportBytes(3)
    const zip=await JSZip.loadAsync(exported.bytes)
    expect(Object.keys(zip.files).some(name=>/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))).toBe(true)
    const reopened=await openPptx(exported.bytes)
    expect(reopened.deck.slides[0]!.elements.length).toBe(3)
    const moved=await s.apply(3,[{op:'setTransform',target:{slide:0,el:shape},box:{x:0,y:1828800,cx:2743200,cy:914400},rotDeg:15}])
    expect(moved.records[0]!.after).toMatchObject({x:0,y:1828800,cx:2743200,cy:914400,rotDeg:15})
    await expect(s.apply(4,[{op:'setFill',target:{slide:0,el:shape},fill:{stops:[{pos:0,color:'#112233'},{pos:1,color:'#445566'}],angle:45}}])).resolves.toMatchObject({generation:5})
    await expect(s.apply(5,[{op:'setStroke',target:{slide:0,el:shape},stroke:null}])).resolves.toMatchObject({generation:6})
    await expect(s.apply(6,[{op:'deleteElement',target:{slide:0,el:shape}}])).resolves.toMatchObject({generation:7})
    await expect(s.apply(7,[{op:'deleteElement',target:{slide:0,el:shape}}])).resolves.toMatchObject({
      generation:7,transaction:{applied:false,failures:[{index:0,error:expect.stringContaining('no element')}]},
    })
    expect((await s.outline(7)).count).toBe(1)
    expect(JSON.stringify(await s.render(7,0))).toContain('original')
    s.close()
  })
  it('adds blank and layout slides, duplicates, reorders and deletes them with live outlines', async () => {
    const {bytes}=await fixture();const s=await createPptxSession(bytes)
    expect(await s.outline(0)).toMatchObject({count:1})
    await expect(s.apply(0,[{op:'duplicateSlide',target:{slide:0}}])).resolves.toMatchObject({generation:1})
    await expect(s.apply(1,[{op:'addBlankSlide',target:{slide:1}}])).resolves.toMatchObject({generation:2})
    const withLayout=await s.apply(2,[{op:'addSlideWithLayout',target:{slide:2},layout:0}])
    expect(withLayout.generation).toBe(3)
    expect((await s.outline(3)).count).toBe(4)
    await expect(s.apply(3,[{op:'moveSlide',target:{slide:1},to:3}])).resolves.toMatchObject({generation:4})
    const outline=await s.outline(4)
    expect(outline.count).toBe(4);expect(outline.slideIds).toHaveLength(4)
    await expect(s.apply(4,[{op:'deleteSlide',target:{slide:3}}])).resolves.toMatchObject({generation:5})
    expect((await s.outline(5)).count).toBe(3)
    await expect(s.apply(5,[{op:'moveSlide',target:{slide:9},to:0}])).resolves.toMatchObject({
      generation:5,transaction:{applied:false,failures:[{index:0,error:expect.stringContaining('slide index 9 is out of range')}]},
    })
    s.close()
  })
  it('exposes deck paths, default font, full render sets and history state for the route contract', async () => {
    const {bytes}=await fixture();const s=await createPptxSession(bytes)
    const outline=await s.outline(0)
    expect(outline.paths).toEqual(['ppt/slides/slide1.xml'])
    expect(outline.slideIds).toEqual(['s_1'])
    expect(typeof outline.defaultFont).toBe('string')
    expect(outline.defaultFont!.length).toBeGreaterThan(0)
    const applied=await s.apply(0,[{op:'addBlankSlide',target:{slide:0}}])
    expect(applied.stateGeneration).toBe(1)
    expect(applied.canUndo).toBe(true);expect(applied.canRedo).toBe(false)
    expect(applied.paths).toHaveLength(2)
    expect(applied.slideIds).toHaveLength(2)
    const renders=await s.renderAll(1,1280)
    expect(renders).toHaveLength(2)
    expect(renders[0]!.widthPx).toBe(1280)
    expect(renders[0]!.partPath).toBe('ppt/slides/slide1.xml')
    await expect(s.renderAll(0,1280)).rejects.toThrow('GENERATION_CONFLICT')
    const undone=await s.undo(1)
    expect(undone).toMatchObject({generation:2,stateGeneration:0,canUndo:false,canRedo:true})
    expect(undone.slides).toHaveLength(1)
    const redone=await s.redo(2)
    expect(redone).toMatchObject({generation:3,stateGeneration:1,canUndo:true,canRedo:false})
    expect(redone.slides).toHaveLength(2)
    expect((await s.outline(3)).paths).toEqual(['ppt/slides/slide1.xml','ppt/slides/slide2.xml'])
    s.close()
  })
  it('rejects ops and fields outside the acceptance whitelist before touching the deck', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    for (const rejected of [
      {op:'addPicture',target:{slide:0},offset:{x:0,y:0,cx:914400,cy:914400},ext:'png',bytes:'aGk='},
      {op:'setBackground',target:{slide:0},kind:'solid',color:'#000000',image:'aGk='},
      {op:'setText',target:{slide:0,el:id},paragraphs:[{runs:[{text:'x',link:{kind:'url',url:'file:///local.txt'}}]}]},
      {op:'addElement',target:{slide:0},kind:'roundRect',offset:{x:0,y:0,cx:914400,cy:914400},adjustments:{adj:'1000'}},
      {op:'addElement',target:{slide:0},kind:'roundRect',offset:{x:NaN,y:0,cx:914400,cy:914400}},
      {op:'addElement',target:{slide:0},kind:'../../etc',offset:{x:0,y:0,cx:914400,cy:914400}},
      {op:'setFill',target:{slide:0,el:id},fill:'#zzzzzz'},
      {op:'setStroke',target:{slide:0,el:id},stroke:{color:'#112233',widthEmu:-1}},
      {op:'reorderElement',target:{slide:0,el:id},dir:'sideways'},
      {op:'setFont',target:{slide:0,el:id},font:'bold'},
      {op:'setFont',target:{slide:0,el:id},font:{color:'#zzzzzz'}},
      {op:'setParagraphFormat',target:{slide:0,el:id},format:null},
      {op:'findReplace',find:'',replace:'x'},
      {op:'findReplace',find:'a',replace:'b',matchCase:'yes'},
    ]) await expect(s.apply(0,[rejected]),JSON.stringify(rejected)).rejects.toThrow(/UNSUPPORTED_OP|UNSUPPORTED_FIELD|INVALID_/)
    await expect(s.apply(0,[{op:'moveSlide',target:{slide:0},to:-1}])).rejects.toThrow('INVALID_TARGET')
    expect((await s.exportBytes(0)).generation).toBe(0)
    s.close()
  })
  it('accepts the bridge font, paragraph and reorder ops with undoable history', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    const applied=await s.apply(0,[{op:'setFont',target:{slide:0,el:id},font:{bold:true}}])
    expect(applied.generation).toBe(1)
    await expect(s.apply(1,[{op:'setFont',target:{slide:0,el:id},font:{fontSizeStep:{dir:1,mode:'ladder'}}}])).resolves.toMatchObject({generation:2})
    const undone=await s.undo(2)
    expect(undone.generation).toBe(3)
    const exported=(await s.exportBytes(3)).bytes
    expect(exported.length).toBeGreaterThan(0)
    s.close()
  })
})
describe('T10 bounded undo/redo snapshot history', () => {
  it('restores deck and package bytes across multi-step undo and redo with generation fencing', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    const original=(await s.exportBytes(0)).bytes
    await s.apply(0,[op(id,'step one')])
    await s.apply(1,[{op:'addElement',target:{slide:0},kind:'textbox',offset:{x:0,y:1828800,cx:1828800,cy:914400}}])
    await s.apply(2,[{op:'duplicateSlide',target:{slide:0}}])
    await s.apply(3,[{op:'deleteSlide',target:{slide:1}}])
    expect((await s.outline(4)).count).toBe(1)
    await expect(s.undo(3)).rejects.toThrow('GENERATION_CONFLICT')
    await expect(s.undo(4)).resolves.toMatchObject({generation:5})
    expect((await s.outline(5)).count).toBe(2)
    await expect(s.undo(5)).resolves.toMatchObject({generation:6})
    await expect(s.undo(6)).resolves.toMatchObject({generation:7})
    await expect(s.undo(7)).resolves.toMatchObject({generation:8})
    expect(await textOf((await s.exportBytes(8)).bytes)).toBe('original')
    await expectSameParts((await s.exportBytes(8)).bytes, original)
    await expect(s.undo(8)).rejects.toThrow('NOTHING_TO_UNDO')
    await expect(s.redo(8)).resolves.toMatchObject({generation:9})
    expect(await textOf((await s.exportBytes(9)).bytes)).toBe('step one')
    await expect(s.redo(9)).resolves.toMatchObject({generation:10})
    await expect(s.redo(10)).resolves.toMatchObject({generation:11})
    await expect(s.redo(11)).resolves.toMatchObject({generation:12})
    expect((await s.outline(12)).count).toBe(1)
    await expect(s.redo(12)).rejects.toThrow('NOTHING_TO_REDO')
    await expect(s.undo(12)).resolves.toMatchObject({generation:13})
    // A new edit clears the redo path: the old future is unreachable.
    await s.apply(13,[{op:'setText',target:{slide:0,el:id},paragraphs:[{runs:[{text:'branch'}]}]}])
    await expect(s.redo(14)).rejects.toThrow('NOTHING_TO_REDO')
    await expect(s.undo(14)).resolves.toMatchObject({generation:15})
    expect(await textOf((await s.exportBytes(15)).bytes)).toBe('step one')
    s.close()
  })
  it('keeps export, render and outline fenced against stale generations', async () => {
    const {bytes}=await fixture();const s=await createPptxSession(bytes)
    await s.apply(0,[{op:'addBlankSlide',target:{slide:0}}])
    await expect(s.render(0,0)).rejects.toThrow('GENERATION_CONFLICT')
    await expect(s.render(1,2)).rejects.toThrow('INVALID_SLIDE')
    await expect(s.outline(0)).rejects.toThrow('GENERATION_CONFLICT')
    await expect(s.exportBytes(0)).rejects.toThrow('GENERATION_CONFLICT')
    await expect(s.render(1,1)).resolves.toMatchObject({partPath: expect.stringMatching(/^ppt\/slides\/slide\d+\.xml$/)})
    s.close()
  })
  it('bounds the history depth so long edit streams cannot grow without limit', async () => {
    const {bytes,id}=await fixture();const s=await createPptxSession(bytes)
    for (let i=0;i<60;i++) await s.apply(i,[op(id,'edit '+i)])
    let generation=60,undos=0
    for (;;) {
      try { await s.undo(generation) } catch (error) { expect((error as Error).message).toBe('NOTHING_TO_UNDO'); break }
      generation++;undos++
    }
    // Depth bound keeps the last eight pre-edit states.
    expect(undos).toBe(8)
    expect(await textOf((await s.exportBytes(generation)).bytes)).toBe('edit 51')
    s.close()
  })
})


describe('retained history byte budget', () => {
  async function padded(total: number) {
    const f=await fixture(), zip=await JSZip.loadAsync(f.bytes)
    for (let n=0;total>0;n++) {
      const size=Math.min(total,6*1024*1024)
      zip.file(`padding/${n}.bin`,new Uint8Array(size)); total-=size
    }
    return {...f,bytes:await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})}
  }
  it('counts archive bytes across both stacks and evicts oldest snapshots', async () => {
    const {bytes,id}=await padded(6*1024*1024),s=await createPptxSession(bytes)
    for(let n=0;n<4;n++)await s.apply(n,[op(id,`edit${n}`)])
    expect(await s.undo(4)).toMatchObject({generation:5,stateGeneration:3,canUndo:true,canRedo:true})
    expect(await s.undo(5)).toMatchObject({generation:6,stateGeneration:2,canUndo:false,canRedo:true})
    await expect(s.undo(6)).rejects.toThrow('NOTHING_TO_UNDO')
    expect(await s.redo(6)).toMatchObject({generation:7,stateGeneration:3,canUndo:true,canRedo:true})
    expect(await s.redo(7)).toMatchObject({generation:8,stateGeneration:4,canUndo:true,canRedo:false})
    await s.undo(8); await s.undo(9)
    await expect(s.undo(10)).rejects.toThrow('NOTHING_TO_UNDO')
    expect(await textOf((await s.exportBytes(10)).bytes)).toBe('edit1')
    s.close()
  })
  it('rejects a single oversized snapshot before mutation', async () => {
    const {bytes,id}=await padded(17*1024*1024),s=await createPptxSession(bytes)
    await expect(s.apply(0,[op(id,'changed')])).rejects.toThrow('HISTORY_LIMIT')
    expect(await textOf((await s.exportBytes(0)).bytes)).toBe('original')
    await expect(s.undo(0)).rejects.toThrow('NOTHING_TO_UNDO');s.close()
  })
  it('rolls back a post-edit budget overflow without consuming redo or generation', async () => {
    const {bytes,id}=await padded(16*1024*1024-160*1024),s=await createPptxSession(bytes)
    await s.apply(0,[op(id,'small')]);await s.undo(1)
    const before=(await s.exportBytes(2)).bytes
    await expect(s.apply(2,[op(id,'x'.repeat(200000))])).rejects.toThrow('HISTORY_LIMIT')
    const digest=async (bytes:Uint8Array)=>{
      const zip=await JSZip.loadAsync(bytes),result:Record<string,string>={}
      for(const [path,file] of Object.entries(zip.files)) if(!file.dir)
        result[path]=createHash('sha256').update(await file.async('uint8array')).digest('hex')
      return result
    }
    expect(await digest((await s.exportBytes(2)).bytes)).toEqual(await digest(before))
    expect(await s.redo(2)).toMatchObject({generation:3,stateGeneration:1,canRedo:false})
    expect(await textOf((await s.exportBytes(3)).bytes)).toBe('small');s.close()
  })
})

it('keeps state, generation and history when redo cannot render the restored deck', async () => {
  const {bytes}=await fixture(),s=await createPptxSession(bytes)
  const batch=Array.from({length:100},()=>({op:'duplicateSlide',target:{slide:0}}))
  await s.apply(0,batch); await s.apply(1,batch)
  expect((await s.outline(2)).count).toBe(201)
  await s.undo(2)
  await expect(s.redo(3)).rejects.toThrow('RENDER_LIMIT')
  expect((await s.outline(3)).count).toBe(101)
  await expect(s.redo(3)).rejects.toThrow('RENDER_LIMIT')
  expect(await s.undo(3)).toMatchObject({generation:4,stateGeneration:0,canRedo:true})
  s.close()
})

describe('bounded local history and structured selection', () => {
  it('undoes and redoes two native edits with monotonic generations and exact original parts', async () => {
    const {bytes,id}=await fixture(); const s=await createPptxSession(bytes)
    const original=await s.exportBytes(0)
    await s.apply(0,[op(id,'one')]); await s.apply(1,[op(id,'two')])
    expect(await s.undo(2)).toMatchObject({generation:3})
    expect(await textOf((await s.exportBytes(3)).bytes)).toBe('one')
    await s.undo(3); await expectSameParts((await s.exportBytes(4)).bytes,original.bytes)
    await s.redo(4); await s.redo(5)
    expect(await textOf((await s.exportBytes(6)).bytes)).toBe('two')
    await expect(s.undo(2)).rejects.toThrow('GENERATION_CONFLICT'); s.close()
  })
  it('does not record rejected batches and clears redo after a divergent edit', async () => {
    const {bytes,id}=await fixture(); const s=await createPptxSession(bytes)
    await expect(s.undo(0)).rejects.toThrow('NOTHING_TO_UNDO')
    await s.apply(0,[op(id,'one')]); await s.undo(1)
    await expect(s.apply(2,[op('missing','bad')])).resolves.toMatchObject({
      generation:2,stateGeneration:0,canUndo:false,canRedo:true,
      transaction:{applied:false,failures:[{index:0,error:expect.stringContaining('no element "missing"')}]},
    })
    await s.redo(2); await s.undo(3); await s.apply(4,[op(id,'different')])
    await expect(s.redo(5)).rejects.toThrow('NOTHING_TO_REDO'); s.close()
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
  await expect(s.undo(18)).rejects.toThrow('NOTHING_TO_UNDO')
  await s.redo(18)
  expect(await textOf((await s.exportBytes(19)).bytes)).toBe('text2')
  s.close()
})

it('rejects an edit crossing the history byte budget without losing the prior undo point', async () => {
  const {bytes,id}=await fixture()
  const zip=await JSZip.loadAsync(bytes)
  const padding=new Uint8Array(2*1024*1024-20*1024).fill(65)
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

it('rejects ambiguous durable element IDs instead of selecting or editing the first match', async () => {
  const seed=await openPptx(await createBlankPptx())
  for (const text of ['first','second']) addElement(seed.deck.slides[0]!,{kind:'textbox',offset:{x:0,y:0,cx:1828800,cy:914400},paragraphs:[{runs:[{text}]}]})
  const zip=await JSZip.loadAsync(await savePptx(seed))
  const path='ppt/slides/slide1.xml'
  let i=0
  const xml=(await zip.file(path)!.async('string')).replace(/(<a16:creationId[^>]*\bid="\{?)[0-9A-Fa-f-]{36}/g,(_,prefix)=>`${prefix}12345678-0000-4000-8000-${String(++i).padStart(12,'0')}`)
  expect(i).toBe(2)
  zip.file(path,xml)
  const bytes=await zip.generateAsync({type:'uint8array'})
  const s=await createPptxSession(bytes)
  await expect(s.selection(0,0,'e_12345678')).rejects.toThrow('AMBIGUOUS_ELEMENT')
  await expect(s.apply(0,[op('e_12345678','wrong target')])).rejects.toThrow('AMBIGUOUS_ELEMENT')
  await expectSameParts((await s.exportBytes(0)).bytes,bytes)
  await expect(s.undo(0)).rejects.toThrow('NOTHING_TO_UNDO');s.close()
})

it('rejects a canonical ID colliding with another element alias before any batch mutation', async () => {
  const seed=await openPptx(await createBlankPptx())
  for(const text of ['first','second']) addElement(seed.deck.slides[0]!,{kind:'textbox',offset:{x:0,y:0,cx:1828800,cy:914400},paragraphs:[{runs:[{text}]}]})
  const zip=await JSZip.loadAsync(await savePptx(seed));const path='ppt/slides/slide1.xml'
  let guid=0,cnv=0
  const xml=(await zip.file(path)!.async('string'))
    .replace(/(<a16:creationId[^>]*\bid="\{?)[0-9A-Fa-f-]{36}/g,(_,prefix)=>`${prefix}${++guid===1?'12345678':'87654321'}-0000-4000-8000-000000000001`)
    .replace(/(<p:cNvPr\b[^>]*\bid=")(\d+)/g,(_,prefix,original)=>`${prefix}${++cnv===1?original:cnv===2?'42':'12345678'}`)
  expect(guid).toBe(2);expect(cnv).toBe(3);zip.file(path,xml)
  const bytes=await zip.generateAsync({type:'uint8array'});const s=await createPptxSession(bytes)
  await expect(s.selection(0,0,'e_12345678')).rejects.toThrow('AMBIGUOUS_ELEMENT')
  await expect(s.apply(0,[op('e_42','must roll back'),op('e_12345678','ambiguous')])).rejects.toThrow('AMBIGUOUS_ELEMENT')
  await expectSameParts((await s.exportBytes(0)).bytes,bytes)
  await expect(s.apply(0,[op('e_87654321','unique')])).resolves.toMatchObject({generation:1})
  s.close()
})

it('supports shape geometry, table creation/editing, and slide visibility operations', async () => {
  const {bytes}=await fixture();const s=await createPptxSession(bytes)
  const addedShape=await s.apply(0,[{op:'addElement',target:{slide:0},kind:'rect',offset:{x:914400,y:914400,cx:1828800,cy:914400}}])
  const shapeId=addedShape.created[0]!.id
  await expect(s.apply(1,[{op:'setShapeGeometry',target:{slide:0,el:shapeId},prst:'roundRect'}])).resolves.toMatchObject({generation:2})
  await expect(s.apply(2,[{op:'flipElements',target:{slide:0},els:[shapeId],axis:'h'}])).resolves.toMatchObject({generation:3})
  const addedTable=await s.apply(3,[{op:'addTable',target:{slide:0},offset:{x:914400,y:2743200,cx:3657600,cy:1828800},rows:2,cols:2}])
  const tableId=addedTable.created[0]!.id
  await expect(s.apply(4,[{op:'setTableCell',target:{slide:0,el:tableId},row:0,col:0,paragraphs:[{runs:[{text:'Cell A1'}]}]}])).resolves.toMatchObject({generation:5})
  await expect(s.apply(5,[{op:'setHidden',target:{slide:0},hidden:true}])).resolves.toMatchObject({generation:6})
  const render=await s.render(6,0)
  expect(render.hidden).toBe(true)
  const table=render.nodes.find(node=>node.type==='table')
  const cell=table?.cells.find(cell=>cell.row===0&&cell.col===0)
  expect(cell?.text?.lines.flatMap(line=>line.runs.map(run=>run.text)).join('')).toBe('Cell A1')
  const reopened=await openPptx((await s.exportBytes(6)).bytes)
  const savedTable=reopened.deck.slides[0]!.elements.find(element=>element.type==='table')
  expect(savedTable?.rows[0]?.[0]?.text?.paragraphs[0]?.runs.map(run=>run.text).join('')).toBe('Cell A1')
  s.close()
})
