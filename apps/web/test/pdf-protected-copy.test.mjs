import assert from 'node:assert/strict'
import test from 'node:test'
import {PDFDocument} from 'pdf-lib'
import {decryptDocument, WrongPasswordError} from '../../pdf/src/main/pdf-crypt.ts'

const load = () => import('../src/editors/pdf-protected-copy.ts')
const permissions = {printing:false,modifying:false,annotating:true,copying:false}

test('the browser writes a protected copy readable with user and owner passwords',async()=>{
 const {createProtectedPdfCopy} = await load()
 const doc = await PDFDocument.create()
 doc.setTitle('Private fixture')
 const page=doc.addPage([240,320])
 page.drawText('Private fixture content')
 const field=doc.getForm().createTextField('privateField')
 field.setText('Private field value')
 field.addToPage(page,{x:20,y:20,width:100,height:20})
 await doc.attach(new TextEncoder().encode('Private attachment'), 'fixture.txt')
 const before = await doc.save()
 const original = before.slice()
 const protectedBytes = await createProtectedPdfCopy(before,{
  userPassword:'打开文档',ownerPassword:'audit-owner',permissions,
 })
 assert.deepEqual(before,original)
 assert.notEqual(protectedBytes,before)
 assert.equal(Buffer.from(protectedBytes).includes('Private fixture'),false)
 await assert.rejects(decryptDocument(protectedBytes,''),WrongPasswordError)
 await assert.rejects(decryptDocument(protectedBytes,'incorrect'),WrongPasswordError)
 for (const [password,unlockedAs] of [['打开文档','user'],['audit-owner','owner']]){
  const result = await decryptDocument(protectedBytes,password)
  assert.equal(result.unlockedAs,unlockedAs)
  assert.deepEqual(result.permissions,permissions)
  const reopened = await PDFDocument.load(result.bytes)
  assert.equal(reopened.getTitle(),'Private fixture')
  assert.equal(reopened.getForm().getTextField('privateField').getText(),'Private field value')
  assert.deepEqual(reopened.getPage(0).getSize(),{width:240,height:320})
 }
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const task=getDocument({data:protectedBytes.slice(),password:'打开文档',useSystemFonts:true})
 try{
  const opened=await task.promise
  assert.match((await (await opened.getPage(1)).getTextContent()).items.map(item=>item.str).join(' '),/Private fixture content/)
  assert.ok((await opened.getAttachments()).has('fixture.txt'))
  assert.equal(new TextDecoder().decode(await opened.getAttachmentContent('fixture.txt')),'Private attachment')
 }finally{await task.destroy()}
})

test('the browser rejects invalid passwords or a canceled copy before parsing source bytes',async()=>{
 const {createProtectedPdfCopy} = await load()
 const input = new Uint8Array()
 const protection = {userPassword:'ok',ownerPassword:'owner',permissions}
 await assert.rejects(createProtectedPdfCopy(input,{...protection,userPassword:'abc\x00extra'}),/password/i)
 await assert.rejects(createProtectedPdfCopy(input,{...protection,userPassword:'界'.repeat(43)}),/password/i)
 await assert.rejects(createProtectedPdfCopy(input,{...protection,ownerPassword:protection.userPassword}),/owner password/i)
 const controller = new AbortController()
 controller.abort()
 await assert.rejects(createProtectedPdfCopy(input,protection,controller.signal),{name:'AbortError'})
})
