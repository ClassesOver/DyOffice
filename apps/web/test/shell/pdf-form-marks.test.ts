import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import type {PDFPageProxy} from 'pdfjs-dist'
import type {FormWidget} from '../../../pdf/src/renderer/form-catalog'
vi.mock('pdfjs-dist/legacy/build/pdf.mjs',()=>({OPS:{save:1,restore:2,transform:3,paintFormXObjectBegin:4,paintFormXObjectEnd:5,constructPath:6,endPath:7}}))
import {planPdfFormMark,validatePdfFormMark} from '../../src/editors/pdf-form-marks'

function page({rotate=0,unit=1,items=[] as unknown[],shapes=[] as number[][]}={}){
 return {pageNumber:1,view:[10,20,210,320],rotate,userUnit:unit,getTextContent:vi.fn(async()=>({items})),getOperatorList:vi.fn(async()=>({fnArray:shapes.map(()=>6),argsArray:shapes.map(rect=>[8,[],rect])}))} as unknown as PDFPageProxy
}
const text=(str:string,x:number,y:number,width:number)=>({str,transform:[10,0,0,10,x,y],width,height:10})
const widget=(readOnly=false)=>({kind:'checkbox',fieldName:'Approved',pageIndex:0,rect:[30,280,42,292],readOnly}) as FormWidget
beforeEach(()=>{
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({scale:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn()} as unknown as CanvasRenderingContext2D)
 vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/png;base64,Y2hlY2s=')
})
afterEach(()=>vi.restoreAllMocks())

it.each([
 {},{page:0,kind:'check',x:0},{page:1.5,kind:'check',x:0},{page:1,kind:'tick',x:0},
 {page:1,kind:'check',x:Infinity},{page:1,kind:'check',y:NaN},{page:1,kind:'check',x:'2'},
 {page:1,kind:'check',x:0,size:0},{page:1,kind:'check',x:0,size:1001},
 {page:1,kind:'check',anchor_text:'a'.repeat(2001)},{page:1,kind:'check',anchor_text:'  '},
 {page:1,kind:'check',anchor_text:'Label',placement:'diagonal'},
])('rejects invalid mark input %#',input=>expect(()=>validatePdfFormMark(input)).toThrow())

it('validates coordinates without coercion and allows a single axis like PC',()=>{
 expect(validatePdfFormMark({page:1,kind:'cross',y:0})).toMatchObject({page:1,kind:'cross',y:0})
})
it('uses case-insensitive first anchor occurrence, substring geometry, 4pt right gap and vertical center',async()=>{
 const p=page({items:[text('Before APPROVED after',30,280,210),text('approved',100,100,80)]})
 const result=await planPdfFormMark(p,{page:1,kind:'check',anchor_text:'approved'},[])
 expect(result).toMatchObject({kind:'image',x:174,y:29,width:12,height:12,image:{mime:'image/png',base64:'Y2hlY2s='}})
})
it.each([['left',4,29],['above',74,14],['below',74,44]] as const)('centers %s placement around the anchor',async(placement,x,y)=>{
 const result=await planPdfFormMark(page({items:[text('Label',30,280,120)]}),{page:1,kind:'cross',anchor_text:'Label',placement},[])
 expect(result).toMatchObject({kind:'image',x,y,width:12,height:12})
})
it('matches an anchor split across PDF.js text runs',async()=>{
 const result=await planPdfFormMark(page({items:[text('App',30,280,30),text('roved',60,280,50)]}),{page:1,kind:'check',anchor_text:'APPROVED'},[])
 expect(result).toMatchObject({kind:'image',x:104,y:29})
})
it('rejects a missing anchor instead of falling back to supplied coordinates',async()=>{
 await expect(planPdfFormMark(page(),{page:1,kind:'check',anchor_text:'Missing',x:10,y:10},[])).rejects.toThrow(/not found/)
})
it.each([0,90,180,270])('fits a printed square with crop/UserUnit at rotation %s',async rotate=>{
 const p=page({rotate,unit:2,shapes:[[30,280,42,292]]})
 const centers:Record<number,[number,number]>={0:[52,68],90:[532,52],180:[348,532],270:[68,348]}
 const [cx,cy]=centers[rotate]!
 const result=await planPdfFormMark(p,{page:1,kind:'check',x:cx-6,y:cy-6},[])
 expect(result).toMatchObject({kind:'image',x:cx-12,y:cy-12,width:24,height:24})
})
it('sets the matching interactive checkbox instead of painting an image',async()=>{
 expect(await planPdfFormMark(page(),{page:1,kind:'cross',x:20,y:28},[widget()])).toEqual({kind:'checkbox',name:'Approved'})
 expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled()
})
it('rejects a read-only checkbox rather than painting over it',async()=>{
 await expect(planPdfFormMark(page(),{page:1,kind:'check',x:20,y:28},[widget(true)])).rejects.toThrow(/read.only/i)
 expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled()
})
it('clamps explicit display coordinates and renders the existing static mark painter',async()=>{
 const result=await planPdfFormMark(page(),{page:1,kind:'cross',x:-10,y:1000},[])
 expect(result).toMatchObject({kind:'image',x:0,y:288,width:12,height:12})
 expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith('image/png')
})
it('honors cancellation both before and after asynchronous PDF.js reads',async()=>{
 const abort=new AbortController();abort.abort()
 await expect(planPdfFormMark(page(),{page:1,kind:'check',x:0},[],abort.signal)).rejects.toMatchObject({name:'AbortError'})
 const late=new AbortController(),p=page()
 vi.mocked(p.getTextContent).mockImplementation(async()=>{late.abort();return {items:[]} as never})
 await expect(planPdfFormMark(p,{page:1,kind:'check',x:0},[],late.signal)).rejects.toMatchObject({name:'AbortError'})
 expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled()
})

it.each([[0,284,64],[90,544,154],[180,364,524],[270,84,234]] as const)('positions an anchored mark in displayed points at rotation %s with CropBox/UserUnit',async(rotate,x,y)=>{
 const result=await planPdfFormMark(page({rotate,unit:2,items:[text('Label',30,280,120)]}),{page:1,kind:'check',anchor_text:'label'},[])
 expect(result).toMatchObject({kind:'image',x,y,width:12,height:12})
})
it('honors PDF.js line breaks rather than joining unrelated anchor fragments',async()=>{
 const p=page({items:[{...text('App',30,280,30),hasEOL:true},text('roved',60,280,50)]})
 await expect(planPdfFormMark(p,{page:1,kind:'check',anchor_text:'Approved'},[])).rejects.toThrow(/not found/)
})
it('never paints through a read-only checkbox hidden behind an overlapping editable widget',async()=>{
 await expect(planPdfFormMark(page(),{page:1,kind:'check',x:20,y:28},[widget(),widget(true)])).rejects.toThrow(/read.only/i)
})
it('ignores widgets belonging to another page',async()=>{
 const result=await planPdfFormMark(page(),{page:1,kind:'check',x:20,y:28},[{...widget(true),pageIndex:1}])
 expect(result.kind).toBe('image')
})
it('rejects rendering failure without returning a successful image plan',async()=>{
 vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
 await expect(planPdfFormMark(page(),{page:1,kind:'check',x:0},[])).rejects.toThrow(/render/)
})

it('validates plain data fields without invoking getters or accepting unknown keys',()=>{
 const getter=vi.fn(()=>1),input={kind:'check',x:0}
 Object.defineProperty(input,'page',{enumerable:true,get:getter})
 expect(()=>validatePdfFormMark(input)).toThrow()
 expect(getter).not.toHaveBeenCalled()
 expect(()=>validatePdfFormMark({page:1,kind:'check',x:0,extra:true})).toThrow()
 expect(()=>validatePdfFormMark(Object.assign(Object.create({}),{page:1,kind:'check',x:0}))).toThrow()
 expect(()=>validatePdfFormMark({page:1,kind:'check',x:0,[Symbol('extra')]:true})).toThrow()
})

it.each(['text','radio','choice','signature'] as const)('rejects a read-only %s widget instead of drawing over it',async kind=>{
 await expect(planPdfFormMark(page(),{page:1,kind:'check',x:20,y:28},[{...widget(true),kind}])).rejects.toThrow(/read.only/i)
 expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled()
})
it.each(['text','radio','choice','signature'] as const)('rejects an editable %s widget and directs callers to setFormValue',async kind=>{
 await expect(planPdfFormMark(page(),{page:1,kind:'check',x:20,y:28},[{...widget(),kind}])).rejects.toThrow(/setFormValue/)
 expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled()
})
it.each(['text','radio','choice','signature','checkbox'] as const)('still draws a static mark away from %s widgets',async kind=>{
 expect(await planPdfFormMark(page(),{page:1,kind:'check',x:100,y:100},[{...widget(true),kind}])).toMatchObject({kind:'image',x:100,y:100})
})
it('does not cover a non-checkbox field hidden behind an overlapping checkbox',async()=>{
 await expect(planPdfFormMark(page(),{page:1,kind:'check',x:20,y:28},[widget(),{...widget(),kind:'text'}])).rejects.toThrow(/setFormValue/)
})
