import { Editor } from '@tiptap/core'
import type { AgentToolCall } from '@genoffice/agent-core'
import type { CommentInfo } from '@genoffice/docx-engine'
import { editorExtensions } from '../../../apps/docs/src/renderer/editor/extensions'
import { addCommentToRange } from '../../../apps/docs/src/renderer/editor/comments'
import { commentAnchors } from '../../../apps/docs/src/renderer/ai/protocol'
import { AGENT_TOOLS, executeTool, markDocSeen } from '../../../apps/docs/src/renderer/ai/tools'

export const definitions = AGENT_TOOLS
const paragraph = '季度预算'
export const cases = [
  { name: 'insert_content', prompt: '在第 0 段“季度预算”后插入一行两列的表格，两格的文字依次为“项目”和“金额”。', input: { afterBlockIndex: 0, html: '<table><tr><td>项目</td><td>金额</td></tr></table>' } },
  { name: 'apply_ops', prompt: '将第 0 段“季度预算”的全部文字加粗。', input: { ops: [{ op: 'setFont', target: { blockIndexes: [0] }, bold: true }] } },
  { name: 'add_comment', prompt: '给第 0 段“季度预算”整段添加批注“请核对预算”。', input: { blockIndex: 0, comment: '请核对预算' } },
]

export async function check(call: AgentToolCall) {
  if (!cases.some(scenario => scenario.name === call.name)) throw Error('Unknown evaluation tool')
  const editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph', content: [{ type: 'text', text: paragraph }] }] } })
  try {
    const comments: CommentInfo[] = []
    markDocSeen(editor)
    const result = await executeTool(editor, call, { bullet: null, ordered: null }, undefined, undefined, null, {
      list: () => comments, resolve: () => false, reply: () => false,
      add(range, text) {
        if (!addCommentToRange(editor, range.from, range.to, '1')) return null
        comments.push({ id: '1', text, author: 'Evaluator', date: '2026-01-01T00:00:00Z' })
        return '1'
      },
    })
    const doc = editor.state.doc
    const first = doc.firstChild
    let matches = false
    if (call.name === 'insert_content') {
      const table = doc.maybeChild(1)
      const row = table?.firstChild
      // Tiptap can append an empty paragraph so the caret can move beyond the table.
      const trailing = doc.maybeChild(2)
      const expectedBlocks = doc.childCount === 2 || (doc.childCount === 3 && trailing?.type.name === 'docParagraph' && trailing.childCount === 0)
      matches = expectedBlocks && table?.type.name === 'docTable' && table.childCount === 1 &&
        row?.childCount === 2 && row.child(0).textContent === '项目' && row.child(1).textContent === '金额'
    } else if (call.name === 'apply_ops') {
      matches = doc.childCount === 1 && !!first && first.childCount > 0
      first?.forEach(node => { if (!node.marks.some(mark => mark.type.name === 'bold')) matches = false })
    } else {
      matches = doc.childCount === 1 && comments.length === 1 && comments[0]?.text === '请核对预算' &&
        commentAnchors(editor).get('1')?.excerpt === paragraph
    }
    return { passed: !result.isError && result.mutated && first?.textContent === paragraph && matches, output: result.output, ...(!matches && { document: editor.getJSON() }) }
  } finally { editor.destroy() }
}
