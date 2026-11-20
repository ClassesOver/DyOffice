import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,test,vi} from 'vitest'
vi.mock('../../src/shell/home-hero',()=>({generateHomeHero:vi.fn()}))
import {generateHomeHero} from '../../src/shell/home-hero'
import {HomeHero} from '../../src/shell/HomeHero'

const roots:ReturnType<typeof createRoot>[]=[]
afterEach(async()=>{await act(async()=>roots.splice(0).forEach(root=>root.unmount()));document.body.replaceChildren();vi.clearAllMocks()})
const fallback={greeting:'下午好。',guidance:'有什么想做的吗？'},copy={greeting:'开始新的创作。',guidance:'写文档，也可以整理数据。'}
const props={fallback,language:'zh',csrfToken:'p'.repeat(43),request:vi.fn()}
function mount(){vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root);return {host,root}}

test('shows the original multiline greeting immediately and replaces it only with complete model copy',async()=>{
 let resolve!:(value:typeof copy)=>void
 vi.mocked(generateHomeHero).mockReturnValue(new Promise(done=>{resolve=done}))
 const {root,host}=mount();await act(async()=>root.render(h(HomeHero,props)))
 expect(host.querySelector('h1')?.firstChild?.textContent).toBe(fallback.greeting)
 expect(host.querySelector('.hero-ask')?.textContent).toBe(fallback.guidance)
 await act(async()=>resolve(copy))
 expect(host.querySelector('h1')?.firstChild?.textContent).toBe(copy.greeting)
 expect(host.querySelector('.hero-ask')?.textContent).toBe(copy.guidance)
 await act(async()=>root.render(h(HomeHero,{...props,fallback:{...fallback,greeting:'另一个问候。'}})))
 expect(generateHomeHero).toHaveBeenCalledTimes(1)
})
test('failure and disabled generation retain fallback; obsolete locale results cannot replace the current greeting',async()=>{
 const pending:Array<(value:typeof copy|null)=>void>=[]
 vi.mocked(generateHomeHero).mockImplementation(()=>new Promise(resolve=>pending.push(resolve)))
 const {root,host}=mount();await act(async()=>root.render(h(HomeHero,{...props,enabled:false})))
 expect(generateHomeHero).not.toHaveBeenCalled()
 await act(async()=>root.render(h(HomeHero,props)))
 const first=vi.mocked(generateHomeHero).mock.calls[0][0]
 await act(async()=>root.render(h(HomeHero,{...props,language:'en'})))
 expect(first.signal.aborted).toBe(true)
 await act(async()=>pending[0](copy))
 expect(host.querySelector('.hero-ask')?.textContent).toBe(fallback.guidance)
 await act(async()=>pending[1](null))
 expect(host.querySelector('.hero-ask')?.textContent).toBe(fallback.guidance)
})
