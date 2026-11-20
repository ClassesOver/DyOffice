import test from 'node:test'
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {officeBrowserAsset} from '../helpers/office-browser-assets.mjs'

test('cross-editor tests use the explicitly selected build instead of falling back to old assets',()=>{
 const old=join(tmpdir(),'old-office-build'),fresh=join(tmpdir(),'current-office-build')
 const env={
  DYOFFICE_TEST_OFFICE_ASSETS:old,
  DYOFFICE_TEST_NATIVE_DOCS_DIST:join(fresh,'word'),
  DYOFFICE_TEST_SHEETS_DIST:join(fresh,'excel'),
  DYOFFICE_TEST_SLIDES_DIST:join(fresh,'powerpoint'),
  DYOFFICE_TEST_NATIVE_PDF_DIST:join(fresh,'pdf'),
  DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY:join(fresh,'workspace'),
 }
 assert.deepEqual(['docs','sheets','slides','pdf','local-shell'].map(name=>officeBrowserAsset(name,env)),[
  join(fresh,'word'),join(fresh,'excel'),join(fresh,'powerpoint'),join(fresh,'pdf'),join(fresh,'workspace'),
 ])
 assert.equal(officeBrowserAsset('pdf',{DYOFFICE_TEST_OFFICE_ASSETS:old}),join(old,'pdf'))
})
