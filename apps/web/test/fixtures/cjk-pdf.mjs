import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
export async function cjkPdf() {
 const doc=await PDFDocument.create(); const page=doc.addPage([200,100]); const ctx=doc.context
 const cid=ctx.register(ctx.obj({Type:'Font',Subtype:'CIDFontType0',BaseFont:'STSong-Light',CIDSystemInfo:ctx.obj({Registry:PDFString.of('Adobe'),Ordering:PDFString.of('GB1'),Supplement:4}),DW:1000}))
 const font=ctx.register(ctx.obj({Type:'Font',Subtype:'Type0',BaseFont:'STSong-Light',Encoding:'UniGB-UCS2-H',DescendantFonts:[cid]}))
 page.node.set(PDFName.of('Resources'),ctx.obj({Font:{F1:font}}))
 page.node.set(PDFName.of('Contents'),ctx.register(ctx.stream('BT /F1 18 Tf 20 40 Td <4e2d6587> Tj ET')))
 return Buffer.from(await doc.save())
}
