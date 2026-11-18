import {afterEach, expect, it, vi} from 'vitest'
import {act, createElement as h} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {PreferencesDialog} from '../src/renderer/components/PreferencesDialog'
import {AutoCorrectDialog} from '../src/renderer/components/AutoCorrectDialog'
import {TrackChangesOptionsDialog} from '../src/renderer/components/TrackChangesOptionsDialog'
import {DEFAULT_TRACK_CHANGES_OPTIONS} from '../src/renderer/editor/track-changes-options'
import {LocaleProvider} from '../src/renderer/i18n/locale'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
let root: Root | undefined
let host: HTMLDivElement
Object.assign(window,{desktop:{onLanguageChanged:()=>()=>undefined}})
afterEach(()=>{if(root)act(()=>root!.unmount());root=undefined;host?.remove();localStorage.clear()})
function mount(child: ReturnType<typeof h>) {
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 act(()=>root!.render(h(LocaleProvider,{initial:'en',children:child})))
 return host.querySelector<HTMLElement>('[role="dialog"]')!
}
it.each([PreferencesDialog,AutoCorrectDialog])('scopes preference visuals without losing controls or Escape close (%s)',Component=>{
 const close=vi.fn();const dialog=mount(h(Component,{onClose:close}))
 expect(dialog.classList.contains('editor-settings-dialog')).toBe(true)
 expect(dialog.getAttribute('aria-label')).toBeTruthy()
 const control=dialog.querySelector<HTMLElement>('select,input')!
 expect(control).not.toBeNull()
 act(()=>control.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 expect(close).toHaveBeenCalledOnce()
})
it('keeps track-change draft cancellation and explicit submit separate',()=>{
 const close=vi.fn(),apply=vi.fn()
 const dialog=mount(h(TrackChangesOptionsDialog,{options:DEFAULT_TRACK_CHANGES_OPTIONS,onClose:close,onApply:apply}))
 expect(dialog.classList.contains('editor-settings-dialog')).toBe(true)
 const input=dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!
 act(()=>input.click());expect(apply).not.toHaveBeenCalled()
 act(()=>dialog.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
 expect(apply).toHaveBeenCalledOnce()
 expect(apply.mock.calls[0][0]).not.toEqual(DEFAULT_TRACK_CHANGES_OPTIONS)
})
it('limits B rules to Web settings dialogs and keeps scroll/focus affordances',()=>{
 const css=readFileSync(resolve(__dirname,'../../web/src/editors/docs.css'),'utf8')
 const marker='/* Web-only B settings dialogs'
 expect(css).toContain(marker)
 const rules=css.slice(css.indexOf(marker))
 expect(rules).toContain('.dyoffice-native-docs .editor-settings-dialog')
 expect(rules).toContain('overflow-y: auto')
 expect(rules).toContain(':focus-visible')
 expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|!important|display:\s*none|outline:\s*none/i)
})
