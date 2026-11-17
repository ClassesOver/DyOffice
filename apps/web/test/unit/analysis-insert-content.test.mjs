import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareAnalysisInsertContent,analysisInsertLimits} from '../../../../packages/browser-host/src/analysis-insert-content.ts'
const bytes=text=>new TextEncoder().encode(text)
const report=(text,mediaType='text/plain')=>({role:'report',mediaType,bytes:bytes(text)})
test('prepares literal report text without rendering Markdown, HTML, code or links',()=>{
 const text='# Report\r\n<script>alert(1)</script>\n[link](https://example.invalid)\n=SUM(A1:A2)\n007\t2026-11-17'
 for(const mime of ['text/plain','text/markdown'])assert.deepEqual(prepareAnalysisInsertContent(report(text,mime)),{kind:'text',text})
 assert.equal(prepareAnalysisInsertContent(report('\uFEFF中文')).text,'\uFEFF中文')
})
test('rejects unsupported media/role and invalid UTF-8 or control text',()=>{
 for(const input of [report('x','text/html'),report('x','image/svg+xml'),{...report('x'),role:'chart'},{...report('x'),bytes:new Uint8Array([0xc3,0x28])},report('a\0b'),report('a\u001bb'),report('a\u007fb'),report(''),{...report('x'),bytes:'not bytes'}])assert.throws(()=>prepareAnalysisInsertContent(input),/Cannot prepare analysis content/)
})
test('rejects entire oversized reports instead of truncating or converting',()=>{
 assert.equal(prepareAnalysisInsertContent(report('a'.repeat(analysisInsertLimits.maxCellUnits))).text.length,analysisInsertLimits.maxCellUnits)
 for(const text of ['a'.repeat(analysisInsertLimits.maxTextUnits+1),'中'.repeat(Math.floor(analysisInsertLimits.maxBytes/3)+1)])assert.throws(()=>prepareAnalysisInsertContent(report(text)),/Cannot prepare analysis content/)
})
const table=text=>({role:'table',mediaType:'text/csv',bytes:bytes(text)})
test('CSV keeps formulas, leading zeros and dates literal and preserves trailing blank rows',()=>{
 assert.deepEqual(prepareAnalysisInsertContent(table('=SUM(A1:A2),007,2026-11-17\n+1,@cmd,-1\n,,\n')),{kind:'table',rows:[['=SUM(A1:A2)','007','2026-11-17'],['+1','@cmd','-1'],['','','']]})
 assert.deepEqual(prepareAnalysisInsertContent(table('"a,b","a""b"\n"multi\nline",2')),{kind:'table',rows:[['a,b','a"b'],['multi\nline','2']]})
})
test('CSV rejects malformed quoting, delimiter directives and every bound without truncating',()=>{
 for(const text of ['a,b\nc','"unclosed','a"b','"a"junk','sep=;\na;b',Array(501).fill('x').join('\n'),Array(65).fill('x').join(','),'x'.repeat(4097),Array(51).fill(Array(40).fill('x').join(',')).join('\n')])assert.throws(()=>prepareAnalysisInsertContent(table(text)),/Cannot prepare analysis content/)
 assert.throws(()=>prepareAnalysisInsertContent({...table('x'),mediaType:'text/plain'}),/Cannot prepare analysis content/)
 assert.equal(prepareAnalysisInsertContent(table('x'.repeat(4096))).rows[0][0].length,4096)
 assert.equal(prepareAnalysisInsertContent(table(Array(500).fill('x').join('\n'))).rows.length,500)
 assert.equal(prepareAnalysisInsertContent(table(Array(64).fill('x').join(','))).rows[0].length,64)
 assert.equal(prepareAnalysisInsertContent(table(Array(50).fill(Array(40).fill('x').join(',')).join('\n'))).rows.length,50)
})

test('report rows and per-line units share conservative native adapter limits',()=>{for(const text of [Array(501).fill('a').join('\n'),'a'.repeat(4097)])assert.throws(()=>prepareAnalysisInsertContent(report(text)));assert.equal(prepareAnalysisInsertContent(report(Array(500).fill('a').join('\n'))).text.split('\n').length,500)})
