import {expect,test,vi} from 'vitest'
import {createDocsBridge} from '../../src/editors/docs-bridge'
const fixture=()=>createDocsBridge({getState:()=>({name:'report.docx'})} as never,'file',{language:'zh'} as never,()=>{})
test('browser print invokes the browser dialog and reports errors rather than a fabricated success',async()=>{
 const print=vi.spyOn(window,'print').mockImplementation(()=>{})
 try{const api=fixture().api;expect(await api.print()).toEqual({ok:true});expect(print).toHaveBeenCalledOnce();print.mockImplementation(()=>{throw Error('blocked')});expect((await api.print()).ok).toBe(false)}finally{print.mockRestore()}
})
test('HTML export initiates an actual download and revokes its temporary URL',async()=>{
 const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:download'),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{}),click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 try{expect((await fixture().api.exportHtml('report.html','<p>hello</p>')).ok).toBe(true);expect(create).toHaveBeenCalledOnce();expect(click).toHaveBeenCalledOnce();await new Promise(resolve=>setTimeout(resolve,5));expect(revoke).toHaveBeenCalledWith('blob:download')}finally{vi.restoreAllMocks()}
})
test('clipboard image copy rejects unavailable permission and never returns success without browser write',async()=>{
 const bridge=fixture();await expect(bridge.api.copyImageToClipboard('data:image/png;base64,AA==')).rejects.toThrow()
})
test('AI panel preferences are updated and emitted in the current mounted editor',async()=>{
 const api=fixture().api,changed=vi.fn(),stop=api.onAiPanelPrefsChanged(changed)
 await api.setAiPanelPrefs({side:'right'});expect((await api.getAiPanelPrefs()).side).toBe('right');expect(changed).toHaveBeenCalledOnce();stop()
})
