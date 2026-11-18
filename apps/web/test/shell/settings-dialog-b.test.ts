import {expect,test} from 'vitest'
import {readFileSync} from 'node:fs'
test('portalled settings dialog B styles are scoped, tokenized and allow narrow and long-content layouts',()=>{
 const css=readFileSync('src/shell/settings-dialog-b.css','utf8')
 expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i)
 expect(css).not.toContain('.workspace-config-modal')
 for(const token of ['surface','text','accent','accent-soft','border-subtle','shadow-menu'])expect(css).toContain(`var(--${token})`)
 expect(css).toContain(':is(.ant-modal-content,.ant-modal-container)')
 expect(css).toContain('max-width:calc(100vw - 32px)');expect(css).toContain('max-height:calc(100dvh - 48px)')
 expect(css).toContain('min-height:0;overflow:auto');expect(css).toContain('flex-wrap:wrap');expect(css).toContain(':focus-visible')
})
