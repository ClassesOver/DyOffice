import assert from 'node:assert/strict'
import test from 'node:test'
import * as schema from '../../worker/src/sandbox/pdf-rotation-schema.ts'
const valid = () => [{page:1,degrees:-90},{page:2,degrees:360},{page:100,degrees:0}]
const rejects = value => assert.throws(() => schema.validatePdfRotationOperations(value), error => error.code === 'INVALID_PDF_ROTATION_SCHEMA')

test('rotation operation schema accepts real page/degrees semantics without normalization', () => {
  assert.equal(typeof schema.validatePdfRotationOperations,'function')
  assert.deepEqual(schema.validatePdfRotationOperations(valid()), [{page:1,degrees:-90},{page:2,degrees:360},{page:100,degrees:0}])
})
test('rotation schema snapshots and freezes operations without modifying caller values', () => {
  const input=valid(), result=schema.validatePdfRotationOperations(input)
  assert.notEqual(result,input); assert.notEqual(result[0],input[0]); assert.ok(Object.isFrozen(result)); assert.ok(result.every(Object.isFrozen))
  input[0].page=9; input.push({page:3,degrees:90})
  assert.deepEqual(result,[{page:1,degrees:-90},{page:2,degrees:360},{page:100,degrees:0}])
})
test('rotation schema bounds operation count and page indices before parsing bytes', () => {
  for(const v of [null,{},[],Array.from({length:101},(_,i)=>({page:i+1,degrees:90}))])rejects(v)
  for(const page of [0,-1,101,1.1,Number.MAX_SAFE_INTEGER+1,Infinity,NaN,'1',null])rejects([{page,degrees:90}])
  assert.equal(schema.validatePdfRotationOperations(Array.from({length:100},(_,i)=>({page:i+1,degrees:90}))).length,100)
})
test('rotation schema requires safe integer quarter-turn angles and refuses duplicate pages', () => {
  for(const degrees of [45,1.1,Infinity,-Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'90',null])rejects([{page:1,degrees}])
  rejects([{page:1,degrees:90},{page:1,degrees:180}])
  assert.deepEqual(schema.validatePdfRotationOperations([{page:1,degrees:9007199254740960}]),[{page:1,degrees:9007199254740960}])
})
test('rotation schema refuses bytes paths profile fields and all noncanonical operation keys', () => {
  for(const key of ['path','bytes','profileId','command','__proto__'])rejects([{page:1,degrees:90,[key]:'untrusted'}])
  rejects([{page:1}]); rejects([{degrees:90}]); rejects([null]); rejects([[]])
  const symbol={page:1,degrees:90}; symbol[Symbol('extra')]=1; rejects([symbol])
  const hidden={page:1,degrees:90}; Object.defineProperty(hidden,'extra',{value:1}); rejects([hidden])
})
test('rotation schema refuses accessors without running them', () => {
  let touched=false
  const op={degrees:90}; Object.defineProperty(op,'page',{get(){touched=true;return 1},enumerable:true}); rejects([op]); assert.equal(touched,false)
  const ops=Array(1); Object.defineProperty(ops,'0',{get(){touched=true;return {page:1,degrees:90}},enumerable:true}); rejects(ops); assert.equal(touched,false)
})
test('rotation schema refuses sparse and extended arrays and inherited operation records', () => {
  rejects(Array(1)); const extended=valid();extended.path='x';rejects(extended)
  const symbolic=valid();symbolic[Symbol('x')]=1;rejects(symbolic)
  rejects([Object.create({page:1,degrees:90})]); rejects([new Date()])
  const hidden={page:1,degrees:90};Object.defineProperty(hidden,'page',{value:1,enumerable:false});rejects([hidden])
})
test('rotation schema accepts null-prototype JSON records as frozen ordinary snapshots', () => {
  const op=Object.assign(Object.create(null),{page:1,degrees:90})
  assert.deepEqual(schema.validatePdfRotationOperations([op]),[{page:1,degrees:90}])
})
