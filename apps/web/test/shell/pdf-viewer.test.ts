import {test,expect,vi,beforeEach} from 'vitest'
const fake=vi.hoisted(()=>({getDocument:vi.fn()}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs',()=>({getDocument:fake.getDocument,GlobalWorkerOptions:{workerSrc:''}}))
import {mountPdfEditor} from '../../src/editors/pdf-entry'
beforeEach(()=>fake.getDocument.mockReset())
test('viewer text preserves the line breaks used by PDF mutation locators',async()=>{
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()}),getTextContent:async()=>({items:[{str:'First line',hasEOL:true},{str:'Second line',hasEOL:false}]}),getAnnotations:async()=>[]})}),destroy:async()=>{}})
 const result=await mountPdfEditor(document.createElement('div'),new Uint8Array([1]))
 expect(result.pages[0].text).toBe('First line\nSecond line')
})
test('failed document loading destroys the worker',async()=>{
 const destroy=vi.fn(async()=>{}); fake.getDocument.mockReturnValue({promise:Promise.reject(new Error('bad PDF')),destroy})
 await expect(mountPdfEditor(document.createElement('div'),new Uint8Array([1]))).rejects.toThrow('bad PDF'); expect(destroy).toHaveBeenCalledOnce()
})
test('viewer passes same-origin packed CMap options',async()=>{
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:0}),destroy:async()=>{}})
 await mountPdfEditor(document.createElement('div'),new Uint8Array([1]))
 expect(fake.getDocument.mock.calls[0][0]).toMatchObject({cMapUrl:'http://localhost/pdfjs/cmaps/',cMapPacked:true})
})
test('oversize page rejects before canvas allocation or rendering and destroys worker',async()=>{
 const render=vi.fn(()=>({promise:Promise.resolve()})); const destroy=vi.fn(async()=>{});
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:()=>({width:1e8,height:1e8}),render,getTextContent:async()=>({items:[]})})}),destroy})
 await expect(mountPdfEditor(document.createElement('div'),new Uint8Array([1]))).rejects.toThrow('PDF_RENDER_LIMIT'); expect(render).not.toHaveBeenCalled();expect(destroy).toHaveBeenCalledOnce()
})
test('oversize input is refused before opening PDF.js',async()=>{
 await expect(mountPdfEditor(document.createElement('div'),new Uint8Array(64*1024*1024+1))).rejects.toThrow('PDF_RENDER_LIMIT');expect(fake.getDocument).not.toHaveBeenCalled()
})
test('too many pages are refused before requesting any page',async()=>{
 const getPage=vi.fn();const destroy=vi.fn(async()=>{});fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:101,getPage}),destroy});
 await expect(mountPdfEditor(document.createElement('div'),new Uint8Array([1]))).rejects.toThrow('PDF_RENDER_LIMIT');expect(getPage).not.toHaveBeenCalled();expect(destroy).toHaveBeenCalledOnce()
})
test('cumulative pixel budget clears already rendered pages and stops before fifth canvas',async()=>{
 const render=vi.fn(()=>({promise:Promise.resolve()}));const destroy=vi.fn(async()=>{});
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:5,getPage:async()=>({getViewport:()=>({width:4000,height:4000}),render,getTextContent:async()=>({items:[]}),getAnnotations:async()=>[]})}),destroy});
 const host=document.createElement('div');await expect(mountPdfEditor(host,new Uint8Array([1]))).rejects.toThrow('PDF_RENDER_LIMIT');expect(render).toHaveBeenCalledTimes(4);expect(host.childElementCount).toBe(0);expect(destroy).toHaveBeenCalledOnce()
})

test('closing during asynchronous page rendering destroys the worker and never repopulates the detached host',async()=>{
 let finish!:(value:void)=>void
 const rendered=new Promise<void>(resolve=>{finish=resolve}),destroy=vi.fn(async()=>{}),started=vi.fn()
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:()=>({width:10,height:10}),render:()=>{started();return {promise:rendered}},getTextContent:async()=>({items:[{str:'late text'}]})})}),destroy})
 const host=document.createElement('div'),abort=new AbortController()
 const mounted=mountPdfEditor(host,new Uint8Array([1]),abort.signal)
 await vi.waitFor(()=>expect(started).toHaveBeenCalled())
 abort.abort();host.replaceChildren();finish()
 await expect(mounted).rejects.toThrow()
 expect(host.childElementCount).toBe(0);expect(destroy).toHaveBeenCalledOnce()
})

test('viewer preserves note reply identity so deleting a thread cannot target a reply by mistake',async()=>{
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()}),getTextContent:async()=>({items:[]}),getAnnotations:async()=>[{id:'7R',subtype:'Text',titleObj:{str:'Reviewer'},contentsObj:{str:'Root'}},{id:'8R',subtype:'Text',inReplyTo:'7R',titleObj:{str:'Author'},contentsObj:{str:'Reply'}}]})}),destroy:async()=>{}})
 const result=await mountPdfEditor(document.createElement('div'),new Uint8Array([1]))
 expect(result.pages[0].annotations[1]).toMatchObject({id:'8R',replyTo:'7R',contents:'Reply'})
})

test('viewer snapshots native form catalog before destroying PDF.js, retaining pages, values, types and options',async()=>{
 let destroyed=false
 const annotations=[[{id:'tx',subtype:'Widget',fieldType:'Tx',fieldName:'Customer',fieldValue:'Alice',rect:[0,0,20,10]}],[{id:'choice',subtype:'Widget',fieldType:'Ch',fieldName:'Region',fieldValue:'EU',options:[{exportValue:'EU',displayValue:'Europe'},{exportValue:'US',displayValue:'USA'}],rect:[0,0,20,10]},{id:'check',subtype:'Widget',fieldType:'Btn',fieldName:'Approved',fieldValue:'Yes',checkBox:true,rect:[0,20,20,30]}]]
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:2,getPage:async(number:number)=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()}),getTextContent:async()=>({items:[]}),getAnnotations:async()=>{expect(destroyed).toBe(false);return annotations[number-1]}}),getFieldObjects:async()=>{expect(destroyed).toBe(false);return null}}),destroy:async()=>{destroyed=true}})
 const result=await mountPdfEditor(document.createElement('div'),new Uint8Array([1]))
 expect(destroyed).toBe(true)
 expect(result.formFields).toEqual(expect.arrayContaining([
  expect.objectContaining({name:'Customer',kind:'text',pageIndex:0,value:'Alice',options:[]}),
  expect.objectContaining({name:'Region',kind:'choice',pageIndex:1,value:'EU',options:['EU','US']}),
  expect.objectContaining({name:'Approved',kind:'checkbox',pageIndex:1,checked:true}),
 ]))
})


test('viewer snapshots saved CropBox UserUnit and rotation separately from preview rotation',async()=>{
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:1,getPage:async()=>({view:[20,30,470,570],userUnit:2,rotate:90,getViewport:()=>({width:1080,height:900}),render:()=>({promise:Promise.resolve()}),getTextContent:async()=>({items:[]}),getAnnotations:async()=>[]})}),destroy:async()=>{}})
 const result=await mountPdfEditor(document.createElement('div'),new Uint8Array([1]),undefined,{1:90})
 expect(result.pageGeometries).toEqual([{pw:900,ph:1080,rot:90,x0:20,y0:30,userUnit:2}])
})
