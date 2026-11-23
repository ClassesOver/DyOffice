import {expect,it} from 'vitest'
import {createBlankPptx,openPptx,savePptx} from '@genoffice/pptx-engine'
import {runTxn} from '@genoffice/pptx-ops'
import {analysisSlideOperations,captureSlideAnalysis} from '../src/renderer/analysis-insert'

it('inserts literal text and table values through the real atomic slide executor',async()=>{
 for(const content of [{kind:'text',text:'<b>literal</b>\n=1+1'},{kind:'table',rows:[['=SUM(A1)','<script>x</script>'],['@user','42']]}] as const){
  const opened=await openPptx(await createBlankPptx())
  const ops=analysisSlideOperations(content,0,960,540)
  const result=runTxn(opened,{ops})
  expect(result.applied).toBe(true)
  if(content.kind==='table')expect(opened.deck.slides[0]!.elements.at(-1)!.type).toBe('table')
  const xml=JSON.stringify(opened.deck.slides[0]!.elements)
  expect(xml).toContain(content.kind==='text'?'<b>literal</b>':'=SUM(A1)')
  expect(xml).toContain(content.kind==='text'?'=1+1':'<script>x</script>')
  const reopened=await openPptx(await savePptx(opened))
  expect(JSON.stringify(reopened.deck.slides[0]!.elements)).toContain(content.kind==='text'?'=1+1':'=SUM(A1)')
  if(content.kind==='table')expect(reopened.deck.slides[0]!.elements.at(-1)!.type).toBe('table')
 }
})
it('captures identity, slide, selection, generation and blocks queued stale or unauthorized writes',async()=>{
 let state:any={identity:{},slideId:'slide1',index:0,selection:'[]',generation:1,width:960,height:540,scale:1},hold=0,writes=0
 const capture=()=>captureSlideAnalysis({current:()=>state,hold:()=>hold++,run:async(_ops,check)=>{await Promise.resolve();if(!check())return false;writes++;return true}})
 for(const key of ['identity','slideId','index','selection','generation','scale']){
  const saved=state,c=capture();state={...state,[key]:key==='identity'?{}:'changed'}
  expect(c.matches()).toBe(false);expect(await c.apply({kind:'text',text:'x'},()=>true)).toBe(false);state=saved
 }
 const c=capture();expect(await c.apply({kind:'text',text:'x'},()=>false)).toBe(false)
 let authorized=true
 const queued=captureSlideAnalysis({current:()=>state,hold:()=>hold++,run:async(_ops,check)=>{authorized=false;return check()}})
 expect(await queued.apply({kind:'text',text:'x'},()=>authorized)).toBe(false)
 expect(writes).toBe(0)
 expect(hold).toBe(1)
 state=null;expect(c.matches()).toBe(false)
})

it('refuses tables that exceed native dimensions or page capacity without truncation',()=>{
 expect(()=>analysisSlideOperations({kind:'table',rows:Array.from({length:76},()=>['x'])},0,960,540)).toThrow(/75 rows/)
 expect(()=>analysisSlideOperations({kind:'table',rows:[['x'.repeat(4096)]]},0,960,540)).toThrow(/does not fit/)
})
it('rejects malformed initial table matrices atomically',async()=>{
 for(const cells of [[['x'],['y']],[[1]],[['x','y']],null]){
  const opened=await openPptx(await createBlankPptx()),before=opened.deck.slides[0]!.elements.length
  expect(runTxn(opened,{ops:[{op:'addTable',target:{slide:0},rows:1,cols:1,cells,offset:{x:0,y:0,cx:1000000,cy:1000000}}]}).applied).toBe(false)
  expect(opened.deck.slides[0]!.elements.length).toBe(before)
 }
})
const PNG_1x1='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
it('inserts a verified analysis image as a native picture, aspect ratio kept, plus provenance',async()=>{
 const opened=await openPptx(await createBlankPptx())
 const ops=analysisSlideOperations({kind:'image',mediaType:'image/png',base64:PNG_1x1,width:1,height:1,alt:'chart',provenance:['Unverified analysis.']},0,960,540)
 expect(ops.map(op=>(op as {op:string}).op)).toEqual(['addPicture','addElement'])
 const picture=ops[0] as {offset:{cx:number;cy:number}}
 expect(picture.offset.cx).toBe(picture.offset.cy)
 const result=runTxn(opened,{ops})
 expect(result.applied).toBe(true)
 const reopened=await openPptx(await savePptx(opened))
 const elements=reopened.deck.slides[0]!.elements
 expect(elements.some(el=>el.type==='picture')).toBe(true)
 expect(JSON.stringify(elements)).toContain('Unverified analysis.')
})
it('rejects an image whose declared size does not match its header',()=>{
 expect(()=>analysisSlideOperations({kind:'image',mediaType:'image/png',base64:PNG_1x1,width:2,height:1,alt:''},0,960,540)).toThrow()
})
it('positions the picture and provenance using the actual wide-slide geometry',()=>{
 const [picture,note]=analysisSlideOperations({kind:'image',mediaType:'image/png',base64:PNG_1x1,width:1,height:1,alt:'chart',provenance:['Frozen result']},0,960,540,.75) as {offset:{x:number;y:number;cx:number;cy:number}}[]
 expect(picture!.offset.x+picture!.offset.cx/2).toBe(6_096_000)
 expect(note!.offset.y+note!.offset.cy).toBe(6_172_200)
})
