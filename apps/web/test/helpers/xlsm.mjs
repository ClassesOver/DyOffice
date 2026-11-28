import JSZip from 'jszip'

const workbookType = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
export const vbaFixture = Buffer.from('inert VBA round-trip test marker')

export async function macroWorkbook(xlsx, project = vbaFixture) {
  const zip = await JSZip.loadAsync(xlsx)
  const types = await zip.file('[Content_Types].xml').async('string')
  zip.file('[Content_Types].xml', types
    .replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', workbookType)
    .replace('</Types>', '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'))
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string')
  zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>',
    '<Relationship Id="rIdMacro" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>'))
  zip.file('xl/vbaProject.bin', project)
  return zip.generateAsync({ type:'nodebuffer', compression:'DEFLATE' })
}
