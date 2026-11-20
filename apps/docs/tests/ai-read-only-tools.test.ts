import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsSkill } from '../src/renderer/ai/docs-skill'
import { executeTool, type AiCommentsAccess } from '../src/renderer/ai/tools'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()))
function readOnlyEditor() {
  const editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'Keep original' }] }] } })
  editors.push(editor); editor.setEditable(false)
  return editor
}

it('hides every current-document mutation when Word editing authority is unavailable', () => {
  const editor = readOnlyEditor()
  const skill = createDocsSkill(() => editor, () => ({ bullet: null, ordered: null }))
  const names = skill.tools.map(tool => tool.name)
  for (const name of ['insert_chart', 'edit_chart', 'insert_image', 'insert_picture', 'generate_image',
    'reply_comment', 'resolve_comment', 'add_comment', 'delete_comment', 'accept_changes', 'reject_changes',
    'insert_footnote', 'insert_endnote', 'edit_note', 'delete_note', 'set_header_footer', 'set_page_setup',
    'insert_section_break', 'define_style', 'set_watermark', 'insert_text_box']) expect(names).not.toContain(name)
  expect(names).toContain('read_blocks')
  expect(names).toContain('list_styles')
  expect(names).toContain('create_document')
})

it('rejects a stale chart call after Word has become read-only without altering its body', async () => {
  const editor = readOnlyEditor(), before = editor.state.doc
  const result = await executeTool(editor, { id: 'chart', name: 'insert_chart', input: {
    kind: 'bar', categories: ['Q1'], series: [{ name: 'Revenue', values: [42] }],
  } }, { bullet: null, ordered: null })
  expect(result.isError).toBe(true)
  expect(result.output).toContain('read-only')
  expect(editor.state.doc.eq(before)).toBe(true)
})

it('does not insert a downloaded image after Word loses editing authority while decoding', async () => {
  const editor = readOnlyEditor(), before = editor.state.doc
  editor.setEditable(true)
  const originalImage = window.Image
  class LoadedImage {
    naturalWidth = 4
    naturalHeight = 4
    onload: (() => void) | null = null
    set src(_value: string) {
      editor.setEditable(false)
      queueMicrotask(() => this.onload?.())
    }
  }
  window.Image = LoadedImage as unknown as typeof Image
  try {
    const result = await executeTool(editor, { id: 'image', name: 'insert_picture', input: {
      url: 'data:image/png;base64,iVBORw0KGgo=',
    } }, { bullet: null, ordered: null })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('read-only')
    expect(editor.state.doc.eq(before)).toBe(true)
  } finally { window.Image = originalImage }
})

it('keeps comments-only protection writable but stops comments after host authority is lost', async () => {
  const editor = readOnlyEditor()
  let canComment = true, removed = false
  const comments: AiCommentsAccess = {
    canWrite: () => canComment,
    list: () => [{ id: 'c1', author: 'Author', date: '', text: 'Original' }],
    reply: () => true, resolve: () => true, remove: () => { removed = true; return true },
  }
  const skill = createDocsSkill(() => editor, () => ({ bullet: null, ordered: null }), undefined, () => comments)
  expect(skill.tools.map(tool => tool.name)).toContain('delete_comment')
  expect(skill.tools.map(tool => tool.name)).not.toContain('insert_chart')
  const call = { id: 'delete', name: 'delete_comment', input: { id: 'c1' } }
  expect((await skill.executeTool(call)).isError).not.toBe(true)
  expect(removed).toBe(true)
  canComment = false; removed = false
  expect(skill.tools.map(tool => tool.name)).not.toContain('delete_comment')
  expect((await skill.executeTool(call)).isError).toBe(true)
  expect(removed).toBe(false)
})
