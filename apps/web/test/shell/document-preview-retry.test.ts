import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import JSZip from 'jszip'
import {DocumentPreview} from '../../src/shell/DocumentPreview'
let root:Root,host:HTMLDivElement
const metadata=(revision='r1')=>({file:{fileId:'a',revision},downloadEndpoint:`/api/v1/files/a/content?revision=${revision}`})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks()})
async function mount(request:()=>Promise<ReturnType<typeof metadata>>){Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(h(DocumentPreview,{fileId:'a',name:'a.xlsx',format:'xlsx',request})))}
const retry=()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='重新加载预览')!
async function bytes(){const zip=new JSZip();zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><v>42</v></c></row></sheetData></worksheet>');return zip.generateAsync({type:'uint8array'})}
test.each(['metadata','content'])('a failed %s request can retry the latest revision without closing the tab',async stage=>{
 const data=await bytes();let fail=true
 const request=vi.fn(async()=>{if(fail&&stage==='metadata')throw Error('unavailable');return metadata(fail?'r1':'r2')})
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>fail?new Response(null,{status:503}):new Response(data))
 await mount(request)
 expect(host.textContent).toContain('无法生成只读预览');expect(retry()).toBeTruthy()
 fail=false;await act(async()=>retry().click())
 await vi.waitFor(()=>expect(host.querySelector('td')?.textContent).toBe('42'))
 expect(request).toHaveBeenCalledTimes(2)
 expect(fetch).toHaveBeenLastCalledWith('/api/v1/files/a/content?revision=r2',expect.anything())
 expect(host.querySelector('a')?.getAttribute('href')).toContain('revision=r2')
 expect(host.textContent).not.toContain('无法生成只读预览')
})
test('pending retry prevents duplicate requests and removes the previous download address',async()=>{
 let finish!:(value:ReturnType<typeof metadata>)=>void,count=0
 const request=vi.fn(async()=>{if(++count===1)return metadata();return new Promise<ReturnType<typeof metadata>>(resolve=>{finish=resolve})})
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:503}))
 await mount(request)
 const button=retry();expect(button).toBeTruthy()
 await act(async()=>{button.click();button.click()})
 expect(request).toHaveBeenCalledTimes(2)
 expect(host.querySelector('a')).toBeNull()
 await act(async()=>finish(metadata('r2')))
})

test('a late retry response cannot publish an old download address after changing documents',async()=>{
 const data=await bytes();let finish!:(value:ReturnType<typeof metadata>)=>void,count=0
 const request=vi.fn(async(path?:string)=>{if(path?.endsWith('/b'))return {file:{fileId:'b',revision:'b1'},downloadEndpoint:'/api/v1/files/b/content?revision=b1'};if(++count===1)throw Error('unavailable');return new Promise<ReturnType<typeof metadata>>(resolve=>{finish=resolve})})
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(data))
 await mount(request);await act(async()=>retry().click())
 await act(async()=>root.render(h(DocumentPreview,{fileId:'b',name:'b.xlsx',format:'xlsx',request})))
 await vi.waitFor(()=>expect(host.querySelector('td')?.textContent).toBe('42'))
 await act(async()=>finish(metadata('late-a')))
 expect(host.querySelector('a')?.getAttribute('href')).toBe('/api/v1/files/b/content?revision=b1')
 expect(fetch).toHaveBeenCalledTimes(1)
})
