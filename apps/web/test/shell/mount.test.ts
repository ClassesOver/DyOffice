import {test,expect,vi} from 'vitest'
test('the original shell mounts with native chrome and real Web bridge queries',async()=>{
 HTMLElement.prototype.scrollIntoView=vi.fn() // jsdom has no scrolling/layout; browser gate verifies the real behavior
 document.body.innerHTML='<div id="app"></div>'
 sessionStorage.setItem('dyoffice-user-token','test')
 const requests:string[]=[]
 vi.stubGlobal('fetch',async(input:string)=>{requests.push(input);return {ok:true,json:async()=>input.includes('preferences')?{theme:'system',language:'zh'}:[]}})
 await import('../../src/shell/main')
 await vi.waitFor(()=>expect(document.querySelector('.home .sidebar .logo-lockup')).not.toBeNull())
 await vi.waitFor(()=>expect(document.querySelectorAll('.quick-card').length).toBe(5))
 expect(document.querySelector('.tab-bar')).not.toBeNull()
 // The files list loads asynchronously after the home shell renders.
 await vi.waitFor(()=>expect(requests).toContain('/api/files'))
 expect(document.querySelector('.account-entry')?.textContent).toContain('个人工作区')
 expect(document.querySelector('.home')?.textContent).not.toContain('.md')
 ;(document.querySelector('.account-btn') as HTMLButtonElement).click()
 await vi.waitFor(()=>expect([...document.querySelectorAll('button')].some(b=>b.textContent==='个人设置')).toBe(true))
 ;([...document.querySelectorAll('button')].find(b=>b.textContent==='个人设置') as HTMLButtonElement).click()
 await vi.waitFor(()=>expect(document.querySelector('.set-dialog')).not.toBeNull())
 expect(document.querySelector('.set-dialog')?.textContent).toContain('开发访问令牌')
 expect(document.querySelectorAll('.set-nav-item:disabled').length).toBeGreaterThan(0)
 expect(requests.every(path=>path==='/api/preferences'||path==='/api/files')).toBe(true)
})
