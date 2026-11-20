import test from 'node:test'
import assert from 'node:assert/strict'
import { toolsForCreateDocumentTypes } from '../../../docs/src/renderer/ai/create-document-capabilities.ts'

const tool = {
  name: 'create_document',
  description: 'Create a document.',
  inputSchema: {
    type: 'object',
    properties: { type: { type: 'string', enum: ['docx', 'pdf', 'md', 'html'] } },
  },
}

test('create_document keeps PC formats when host has no capability restriction', () => {
  assert.deepEqual(toolsForCreateDocumentTypes([tool])[0], tool)
})

test('create_document schema advertises only formats implemented by the host', () => {
  const [limited] = toolsForCreateDocumentTypes([tool], ['docx', 'pdf'])
  assert.deepEqual(limited.inputSchema.properties.type.enum, ['docx', 'pdf'])
  assert.match(limited.description, /Supported types on this host: docx, pdf/)
})

test('create_document is omitted when the host supports no standalone output formats', () => {
  assert.deepEqual(toolsForCreateDocumentTypes([tool], []), [])
})
