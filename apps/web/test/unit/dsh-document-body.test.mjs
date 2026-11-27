import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import {blankChannelDocument} from '../../server/src/modules/assistant-channel/blank-document.ts'

test('DSH creates a Word file with escaped, editable body paragraphs', async () => {
  const {name,bytes} = await blankChannelDocument({format:'docx',title:'活动策划',body:'活动安排 & 筹备\n\n  比较 <A> 和 B 🚀'})
  assert.equal(name,'活动策划.docx')
  const archive = await JSZip.loadAsync(bytes)
  const document = await archive.file('word/document.xml').async('string')
  assert.match(document, /活动安排 &amp; 筹备/)
  assert.match(document, /<w:p\/><w:p><w:r><w:t xml:space="preserve">  比较 &lt;A&gt; 和 B 🚀/)
  for (const input of [{format:'pdf',body:'正文'},{format:'docx',body:' '},{format:'docx',body:'异常\u0000字符'}]) {
    await assert.rejects(blankChannelDocument({...input,title:'无效'}),{statusCode:400})
  }
})
