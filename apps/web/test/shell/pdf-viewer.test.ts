import {test,expect,vi,beforeEach} from 'vitest'
const fake=vi.hoisted(()=>({getDocument:vi.fn()}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs',()=>({getDocument:fake.getDocument,GlobalWorkerOptions:{workerSrc:''}}))
import {mountPdfEditor} from '../../src/editors/pdf-entry'
beforeEach(()=>fake.getDocument.mockReset())
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
 fake.getDocument.mockReturnValue({promise:Promise.resolve({numPages:5,getPage:async()=>({getViewport:()=>({width:4000,height:4000}),render,getTextContent:async()=>({items:[]})})}),destroy});
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
