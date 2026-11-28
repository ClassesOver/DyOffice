import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import * as CFB from 'cfb'
import officeCrypto from 'officecrypto-tool'
import JSZip from 'jszip'

const fixture=()=>readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
const codec=async()=>(await import('../../server/src/modules/files/workbook-password.ts')).createWorkbookPasswordCodec()
const password='示例 password 123'

test('the Web workbook adapter opens Desktop Agile files and reseals validated edits',async()=>{
 const {open,seal}=await codec(),plain=await fixture(),input=officeCrypto.encrypt(plain,{password}),original=Buffer.from(input)
 const working=await open(input,password)
 assert.deepEqual(working.bytes,plain)
 assert.equal(working.file.format,'xlsx')
 assert.equal(working.file.sha256,createHash('sha256').update(input).digest('hex'))
 assert.equal(working.file.size,input.length)
 assert.ok(input.equals(original))
 const zip=await JSZip.loadAsync(working.bytes)
 const path='xl/worksheets/sheet1.xml',sheet=await zip.file(path).async('string')
 const updated=sheet.replace('</sheetData>','<row r="5000"><c r="A5000"><v>42</v></c></row></sheetData>')
 assert.notEqual(updated,sheet)
 zip.file(path,updated)
 const edited=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})
 const resealed=await seal(edited,password)
 assert.notDeepEqual(resealed.bytes,edited)
 assert.notDeepEqual(resealed.bytes,input)
 assert.deepEqual(await officeCrypto.decrypt(resealed.bytes,{password}),edited)
 const reopened=await open(resealed.bytes,password)
 assert.deepEqual(reopened.file,resealed.file)
 assert.match(await (await JSZip.loadAsync(reopened.bytes)).file(path).async('string'),/<c r="A5000"><v>42<\/v><\/c>/)
})

test('canceling an in-flight password operation releases its bounded worker slot',async()=>{
 const {createWorkbookPasswordCodec}=await import('../../server/src/modules/files/workbook-password.ts')
 const {open,seal}=createWorkbookPasswordCodec({maxConcurrent:1}),plain=await fixture()
 const sealed=officeCrypto.encrypt(plain,{password}),abort=new AbortController()
 const opening=open(sealed,password,abort.signal)
 await assert.rejects(seal(plain,password),{statusCode:503,retryAfter:1})
 abort.abort()
 await assert.rejects(opening,{name:'AbortError'})
 assert.deepEqual((await open(sealed,password)).bytes,plain)
})

test('Standard password protection is readable and saves use Agile protection',async()=>{
 const {open,seal}=await codec(),plain=await fixture()
 const input=officeCrypto.encrypt(plain,{password,type:'standard'})
 assert.deepEqual((await open(input,password)).bytes,plain)
 await assert.rejects(open(input,'wrong'),{code:'WORKBOOK_PASSWORD_INVALID'})
 const saved=CFB.read((await seal(plain,password)).bytes,{type:'buffer'})
 assert.equal(CFB.find(saved,'/EncryptionInfo').content.subarray(0,8).toString('hex'),'0400040040000000')
})

test('password checks, Agile integrity and the native XLSX type gate all apply',async()=>{
 const {open,seal}=await codec(),plain=await fixture(),input=officeCrypto.encrypt(plain,{password})
 await assert.rejects(open(input,'wrong'),{code:'WORKBOOK_PASSWORD_INVALID'})
 const parsed=CFB.read(input,{type:'buffer'}),packet=CFB.find(parsed,'/EncryptedPackage')
 packet.content[packet.content.length-1]^=1
 await assert.rejects(open(Buffer.from(CFB.write(parsed,{type:'buffer'})),password),{code:'WORKBOOK_ENCRYPTION_INVALID'})
 const pptx=await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
 await assert.rejects(open(officeCrypto.encrypt(pptx,{password}),password),{statusCode:400})
 await assert.rejects(seal(pptx,password),{statusCode:400})
 await assert.rejects(open(plain,password),{code:'WORKBOOK_ENCRYPTION_INVALID'})
 await assert.rejects(seal(plain,''),{statusCode:400})
})
