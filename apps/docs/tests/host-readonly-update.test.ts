import {readFileSync} from 'node:fs'
import {Editor} from '@tiptap/core'
import {expect,it} from 'vitest'
import {editorExtensions} from '../src/renderer/editor/extensions'
const source=readFileSync('src/renderer/App.tsx','utf8')
const setEditable=source.match(/editor\.setEditable\([^\n]*/)?.[0]
if(!setEditable)throw Error('production setEditable call not found')
const applyProtection=new Function('editor','readMode','isProtected','host','writeProtection','editRestriction',setEditable)
const updateBody=source.match(/onUpdate: \(\{ transaction \}\) => \{([\s\S]*?)\n    \},\n  \}\)/)?.[1]
if(!updateBody)throw Error('production onUpdate not found')
const onUpdate=new Function('host','dirtyRef','forceRender','transaction','PHASED_APPEND',updateBody)
it('production protection toggle preserves clean content while real content edits mark dirty',()=>{
 let hostEdits=0;const dirtyRef={current:false},host={onDocumentEdited:()=>hostEdits++}
 const editor=new Editor({element:document.createElement('div'),extensions:editorExtensions,content:{type:'doc',content:[{type:'docParagraph',content:[{type:'text',text:'Original'}]}]},onUpdate:({transaction})=>onUpdate(host,dirtyRef,()=>{},transaction,'phasedAppend')})
 try{
  const before=editor.getJSON();applyProtection(editor,false,true)
  expect(editor.isEditable).toBe(false);expect(editor.getJSON()).toEqual(before)
  expect(dirtyRef.current).toBe(false);expect(hostEdits).toBe(0)
  applyProtection(editor,false,false);expect(editor.isEditable).toBe(true);expect(dirtyRef.current).toBe(false)
  applyProtection(editor,true,false);expect(editor.isEditable).toBe(false);expect(dirtyRef.current).toBe(false)
  applyProtection(editor,false,false)
  editor.commands.insertContent('Genuine edit');expect(dirtyRef.current).toBe(true);expect(hostEdits).toBeGreaterThan(0)
  const edits=hostEdits,changed=editor.getJSON()
  applyProtection(editor,false,true);applyProtection(editor,false,true)
  expect(dirtyRef.current).toBe(true);expect(hostEdits).toBe(edits);expect(editor.getJSON()).toEqual(changed)
 }finally{editor.destroy()}
})
