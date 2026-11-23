import test from 'node:test'
import assert from 'node:assert/strict'
import {codingHarnessConfig} from '../../server/coding-config.mjs'

test('the built-in harness is enabled by default and only explicit off disables it',()=>{
 assert.deepEqual(codingHarnessConfig({}),{})
 assert.deepEqual(codingHarnessConfig({DYOFFICE_CODING_AGENT:'on'}),{})
 assert.equal(codingHarnessConfig({DYOFFICE_CODING_AGENT:'off'}),false)
 assert.deepEqual(codingHarnessConfig({DYOFFICE_CODEX_PATH:'/opt/codex',DYOFFICE_ANALYSIS_PYTHON:'/opt/python'}),{cliPath:'/opt/codex',analysisPython:'/opt/python'})
})
