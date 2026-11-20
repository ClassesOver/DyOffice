import test from 'node:test'
import assert from 'node:assert/strict'
import {documentHandoffPdfTools} from '../../src/editors/document-handoff-spec.ts'

test('PDF document handoff keeps the baseline tools when no capability list is provided',()=>{
 assert.deepEqual(documentHandoffPdfTools(),{
  read:['read_pages','list_inserted_text'],
  write:['insert_text','insert_blank_page'],
 })
})

test('PDF document handoff keeps registered reading tools in the read-only group',()=>{
 assert.deepEqual(documentHandoffPdfTools([
  'read_pages','search_text','read_annotations','get_outline','list_form_fields',
  'insert_text','edit_text','search_text','find_sensitive_info','goto_page',
 ]),{
  read:['read_pages','search_text','read_annotations','get_outline','list_form_fields'],
  write:['insert_text','edit_text','find_sensitive_info'],
 })
})
