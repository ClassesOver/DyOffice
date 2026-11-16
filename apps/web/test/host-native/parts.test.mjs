import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import JSZip from 'jszip'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
test('trusted planner stages bounded immutable archive parts for original Rust writer without choosing host paths',async()=>{
 const input=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)),runner=await sandboxFixture('native')
 const result=await runner.run(input,async session=>{
  const replacement=Buffer.from('<preserved>Updated test part</preserved>')
  const path=await session.writePart(replacement)
  assert.match(path,/^\/work\/part-[a-f0-9-]+$/)
  await assert.rejects(()=>session.writePart(Buffer.alloc(32*1024*1024+1)),{code:'INPUT_LIMIT'})
  await session.request('save_archive',{sourcePath:'/work/input.xlsx',targetPath:'/work/output.xlsx',replacements:[{name:'customXml/t09-preserve.xml',contentPath:path}],removals:[],additions:[]})
  return session.readOutput()
 })
 assert.equal(await (await JSZip.loadAsync(result)).file('customXml/t09-preserve.xml').async('string'),'<preserved>Updated test part</preserved>')
})
test('part staging enforces cumulative bytes, count and closed-session fencing',async()=>{
 const runner=await sandboxFixture('native'),input=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 let closed
 await runner.run(input,async session=>{
  closed=session
  await assert.rejects(()=>session.writePart('../host-path'),{code:'INPUT_LIMIT'})
  const first=await session.writePart(Buffer.alloc(16*1024*1024)),second=await session.writePart(Buffer.alloc(16*1024*1024))
  assert.notEqual(first,second)
  await assert.rejects(()=>session.writePart(Buffer.from('overflow')),{code:'INPUT_LIMIT'})
 })
 await assert.rejects(()=>closed.writePart(Buffer.from('late')),{code:'CLOSED'})
 await runner.run(input,async session=>{
  for(let i=0;i<256;i++)await session.writePart(Buffer.from('x'))
  await assert.rejects(()=>session.writePart(Buffer.from('overflow')),{code:'INPUT_LIMIT'})
 })
})
