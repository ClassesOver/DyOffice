import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseBytesToText } from '../src'
import { buildDocxFixture } from './helpers/fixtures'

describe('Office attachment formatting details', () => {
  it('includes effective DOCX paragraph and character formatting', async () => {
    const zip = await JSZip.loadAsync(await buildDocxFixture())
    const document = await zip.file('word/document.xml')!.async('string')
    zip.file(
      'word/document.xml',
      document
        .replace(
          '<w:pStyle w:val="Heading1"/>',
          '<w:pStyle w:val="Heading1"/><w:jc w:val="center"/>',
        )
        .replace(
          '<w:r><w:t>Annual Report</w:t>',
          '<w:r><w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:eastAsia="黑体"/></w:rPr><w:t>Annual Report</w:t>',
        ),
    )
    const result = await parseBytesToText(
      'report.docx',
      await zip.generateAsync({ type: 'uint8array' }),
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Annual Report')
    expect(result.text).toContain('居中')
    expect(result.text).toContain('加粗')
    expect(result.text).toContain('16 pt')
    expect(result.text).toContain('黑体')
  })

  it('includes PPTX element positions and text formatting', async () => {
    const zip = new JSZip()
    zip.file(
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    )
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="5143500"/><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>',
    )
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    )
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="4572000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="2400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Quarterly Results</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    )
    const result = await parseBytesToText(
      'deck.pptx',
      await zip.generateAsync({ type: 'uint8array' }),
    )

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Quarterly Results')
    expect(result.text).toContain('Title')
    expect(result.text).toContain('左 1 in')
    expect(result.text).toContain('加粗')
    expect(result.text).toContain('#FF0000')
  })
})
