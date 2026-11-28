import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName} from 'pdf-lib'
import {PNG} from 'pngjs'
import {buildSlidesPdf} from '../../src/editors/slides-pdf-download.ts'

test('PPTX PDF exports canonical external URIs and retains internal slide links', async () => {
  const png = PNG.sync.write(new PNG({width:1,height:1})).toString('base64')
  const web = 'https://例子.example/报价?q=季度#页'
  const email = 'mailto:team@example.test?subject=季度报价'
  const targets = [web,email,'#pg2','#pg3','file:///tmp/local.txt','https://[invalid']
  const links = targets.map((href,index) => ({x:index/10,y:0,w:0.08,h:0.2,href}))
  const bytes = await buildSlidesPdf([png,png],160,90,[links,[]],new AbortController().signal)
  const document = await PDFDocument.load(bytes)
  const [first,second] = document.getPages()
  const annotations = first.node.Annots()
  const uri = index => annotations.lookup(index,PDFDict)
    .lookup(PDFName.of('A'),PDFDict)
    .lookup(PDFName.of('URI'),PDFHexString).decodeText()
  assert.equal(uri(0),new URL(web).href)
  assert.equal(uri(1),new URL(email).href)
  assert.equal(annotations.size(),3)

  const destination = annotations.lookup(2,PDFDict).lookup(PDFName.of('Dest'),PDFArray)
  assert.equal(destination.get(0),second.ref)
  assert.equal(destination.get(1).toString(),'/Fit')
})
