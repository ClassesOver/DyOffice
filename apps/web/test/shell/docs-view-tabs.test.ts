import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {ViewTab} from '../../../docs/src/renderer/components/ribbon-tabs'
let root:Root,host:HTMLDivElement,previousDesktop:typeof window.desktop
beforeEach(()=>{previousDesktop=window.desktop;vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();window.desktop=previousDesktop;vi.unstubAllGlobals()})
async function render(extra:Record<string,unknown>={}){
 await act(async()=>root.render(h(ViewTab,{hasDoc:true,filePath:'/files/a/a.docx',zoom:1,darkPage:false,showRuler:false,showNav:false,viewMode:'print',readMode:false,showGrid:false,splitView:false,
 onZoom:vi.fn(),onZoomFit:vi.fn(),onZoomDialog:vi.fn(),onDarkPage:vi.fn(),onShowRuler:vi.fn(),onShowNav:vi.fn(),onViewMode:vi.fn(),onReadMode:vi.fn(),onShowGrid:vi.fn(),onSplitView:vi.fn(),onPagePreview:vi.fn(),...extra})))
}
const button=(text:string)=>[...host.querySelectorAll('button')].find(node=>node.textContent?.includes(text))!
test('unsupported duplicate-document tabs are disabled with an explicit explanation',async()=>{
 await render({newTabUnavailableReason:'Web 版暂不支持同一文档在多个标签中打开。'})
 const node=button('新建标签');expect(node.disabled).toBe(true);expect(node.getAttribute('data-tip')).toContain('同一文档');expect(node.title).toContain('同一文档')
})
test('desktop new tab continues to open the same document',async()=>{
 const openNewTab=vi.fn().mockResolvedValue(undefined);window.desktop={openNewTab} as never
 await render();await act(async()=>button('新建标签').click());expect(openNewTab).toHaveBeenCalledWith('/files/a/a.docx')
})
test('switch tabs renders current list and focuses selected document',async()=>{
 const focusDocsTab=vi.fn().mockResolvedValue(undefined);window.desktop={listDocsTabs:async()=>[{id:'b',title:'乙.docx',focused:false}],focusDocsTab} as never
 await render();await act(async()=>button('切换标签').click());await act(async()=>button('乙.docx').click());expect(focusDocsTab).toHaveBeenCalledWith('b');expect(host.querySelector('.layout-menu')).toBeNull()
})
test('tab list failures are shown without leaving an unhandled rejection',async()=>{
 window.desktop={listDocsTabs:async()=>{throw Error('无法读取标签列表')}} as never
 await render();await act(async()=>button('切换标签').click());expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法读取标签列表')
})
test('Escape closes the switch-tabs popover',async()=>{
 window.desktop={listDocsTabs:async()=>[{id:'b',title:'乙.docx',focused:false}]} as never
 await render();await act(async()=>button('切换标签').click());expect(host.querySelector('.layout-menu')).not.toBeNull()
 await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})))
 expect(host.querySelector('.layout-menu')).toBeNull()
})
test.each(['Escape','outside','trigger'])('a slow tab list cannot reopen the menu after closing by %s',async how=>{
 let finish!:(tabs:{id:string;title:string;focused:boolean}[])=>void
 window.desktop={listDocsTabs:()=>new Promise(resolve=>{finish=resolve})} as never
 await render();await act(async()=>button('切换标签').click())
 await act(async()=>{
  if(how==='Escape')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))
  else if(how==='outside')document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}))
  else button('切换标签').click()
 })
 await act(async()=>finish([{id:'b',title:'乙.docx',focused:false}]))
 expect(host.querySelector('.layout-menu')).toBeNull()
})
