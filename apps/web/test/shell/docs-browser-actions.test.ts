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
test('Word switch-tabs lists live Word application tabs and activates through the parent shell',async()=>{
 const previous=window.aiOfficeTabs,activate=vi.fn().mockResolvedValue(undefined)
 window.aiOfficeTabs={list:async()=>[
  {id:'home',kind:'home',title:'首页',active:false},
  {id:'word-a',kind:'docs',title:'甲.docx',active:true},
  {id:'sheet',kind:'sheets',title:'表.xlsx',active:false},
  {id:'word-b',kind:'docs',title:'乙.docx',active:false},
 ],activate} as never
 try{
  const api=fixture().api
  expect(await api.listDocsTabs()).toEqual([{id:'word-a',title:'甲.docx',focused:true},{id:'word-b',title:'乙.docx',focused:false}])
  await api.focusDocsTab('word-b');expect(activate).toHaveBeenCalledWith('word-b')
  await expect(api.focusDocsTab('sheet')).rejects.toThrow();expect(activate).toHaveBeenCalledOnce()
 }finally{window.aiOfficeTabs=previous}
})
test('Word switch-tabs fails explicitly when the parent application bridge is unavailable',async()=>{
 const previous=window.aiOfficeTabs;window.aiOfficeTabs=undefined as never
 try{const api=fixture().api;await expect(api.listDocsTabs()).rejects.toThrow('当前')}finally{window.aiOfficeTabs=previous}
})
test('saveDocxAs and exportMarkdown download browser blobs and open settings via parent shell',async()=>{
 const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:download'),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{}),click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 const openSettings=vi.fn().mockResolvedValue(undefined)
 const previous=(window as unknown as {dyofficeOpenEditorSettings?:unknown}).dyofficeOpenEditorSettings
 ;(window as unknown as {dyofficeOpenEditorSettings?:unknown}).dyofficeOpenEditorSettings=openSettings
 try{
  const api=fixture().api
  expect(await api.saveDocxAs(new Uint8Array([80,75,3,4]),'copy')).toEqual({path:'copy.docx'})
  expect(await api.exportMarkdown('notes','# Title')).toEqual({ok:true,path:'notes.md'})
  expect(create).toHaveBeenCalledTimes(2);expect(click).toHaveBeenCalledTimes(2)
  await api.openAiModelSettings();await api.openSkillsSettings()
  expect(openSettings).toHaveBeenCalledWith('models',window)
  expect(openSettings).toHaveBeenCalledWith('skills',window)
  await new Promise(resolve=>setTimeout(resolve,5))
  expect(revoke).toHaveBeenCalledWith('blob:download')
 }finally{
  ;(window as unknown as {dyofficeOpenEditorSettings?:unknown}).dyofficeOpenEditorSettings=previous
  vi.restoreAllMocks()
 }
})
