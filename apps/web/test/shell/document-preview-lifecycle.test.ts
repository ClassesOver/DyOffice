import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {DocumentPreview} from '../../src/shell/DocumentPreview'
let root:Root|undefined,container:HTMLDivElement|undefined
afterEach(async()=>{await act(async()=>root?.unmount());container?.remove();vi.unstubAllGlobals()})
test.each(['oversized','http-error'])('preview cancels the unread response body on %s before retaining an error view',async scenario=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1]))},cancel})
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(body,{status:scenario==='http-error'?503:200,headers:scenario==='oversized'?{'content-length':String(64*1024*1024+1)}:{}})))
 const request=vi.fn().mockResolvedValue({file:{fileId:'qa',revision:'rev'},downloadEndpoint:'/api/v1/files/qa/content?revision=rev'})
 container=document.createElement('div');document.body.append(container);root=createRoot(container)
 await act(async()=>root!.render(h(DocumentPreview,{fileId:'qa',name:'QA.pdf',format:'pdf',request})))
 expect(container.textContent).toContain('无法生成只读预览')
 expect(container.querySelector('a')?.getAttribute('href')).toBe('/api/v1/files/qa/content?revision=rev')
 expect(cancel).toHaveBeenCalledOnce()
})
