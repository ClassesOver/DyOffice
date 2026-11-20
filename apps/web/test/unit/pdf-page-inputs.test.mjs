import test from 'node:test'
import assert from 'node:assert/strict'
import {PDF_PAPER_SIZES,parsePdfPageRanges} from '../../src/shell/pdf-page-inputs.ts'

test('PDF paper sizes match PC points and page ranges resolve against only the current revision',()=>{
 assert.deepEqual(PDF_PAPER_SIZES,[{label:'A3',width:842,height:1191},{label:'A4',width:595,height:842},{label:'A5',width:420,height:595},{label:'Letter',width:612,height:792},{label:'Legal',width:612,height:1008}])
 assert.deepEqual(parsePdfPageRanges('all',3),[1,2,3])
 assert.deepEqual(parsePdfPageRanges('3, 1–2，2',3),[1,2,3])
 assert.deepEqual(parsePdfPageRanges(' 1, ',3),[1])
 for(const input of ['',null,[],1,'0','4','2-1','1-4','1,garbage','1e0'])assert.equal(parsePdfPageRanges(input,3),null)
 assert.equal(parsePdfPageRanges('all',0),null)
 assert.equal(parsePdfPageRanges('all',101),null)
})
