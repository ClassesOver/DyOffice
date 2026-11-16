import {test} from 'node:test'
import assert from 'node:assert/strict'
import {cjkPdf} from './fixtures/cjk-pdf.mjs'
import { renderPdfPages } from '../server/src/pdf/raster.mjs'

test('predefined CJK CMap text survives real PDF.js extraction',async()=>{
 const result=await renderPdfPages(await cjkPdf()); assert.equal(result.pages[0].text,'中文')
})
