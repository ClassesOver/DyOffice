import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocx } from '../src/parse'
import { LAZY_MEDIA_PLACEHOLDER_BYTES } from '../src/lazy-media'
import { buildDocx, TINY_PNG_BASE64 } from './helpers/build-docx'

const INLINE_PIC =
  '<w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="P"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="P"/><pic:cNvPicPr/></pic:nvPicPr>' +
  '<pic:blipFill><a:blip r:embed="rId10"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
  '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
  '</a:graphicData></a:graphic></wp:inline></w:drawing>'

describe('media data URLs', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    Buffer.from(TINY_PNG_BASE64, 'base64'),
    Buffer.alloc(LAZY_MEDIA_PLACEHOLDER_BYTES, 0xfb),
  ])('a shared picture is read once and retains its original bytes (case %#)', async (picture) => {
    const bodyXml = Array.from({ length: 3 }, () => `<w:p><w:r>${INLINE_PIC}</w:r></w:p>`).join('')
    const bytes = await buildDocx({
      bodyXml,
      withImage: true,
      binaryParts: [
        {
          path: 'word/media/image1.png',
          extension: 'png',
          contentType: 'image/png',
          base64: picture.toString('base64'),
        },
      ],
    })
    const probe = await JSZip.loadAsync(bytes)
    const zipObjectProto = Object.getPrototypeOf(probe.file('word/media/image1.png')!) as {
      async: (type: string) => Promise<unknown>
    }
    const asyncSpy = vi.spyOn(zipObjectProto, 'async')
    const doc = await parseDocx(bytes)
    const urls = doc.blocks.map((b) => b.imageDataUrl).filter((u): u is string => !!u)
    expect(urls).toHaveLength(3)
    expect(urls[0]).toBe('data:image/png;base64,' + picture.toString('base64'))
    expect(new Set(urls).size).toBe(1)
    expect(
      asyncSpy.mock.contexts.filter(
        (entry) => (entry as { name?: string }).name === 'word/media/image1.png',
      ),
    ).toHaveLength(1)
  })
})
