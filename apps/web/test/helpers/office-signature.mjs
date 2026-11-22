import assert from 'node:assert/strict'
import JSZip from 'jszip'

export async function withOfficeSignatureOrigin(bytes, { declaration = 'relationship' } = {}) {
  const zip = await JSZip.loadAsync(bytes)
  if (declaration === 'encoded-content-type') {
    const types = await zip.file('[Content_Types].xml').async('string')
    assert.match(types, /<\/Types>/)
    zip.file('[Content_Types].xml', types.replace('</Types>',
      '<Override PartName="/custom-signature/origin.sigs" ContentType="application/vnd.openxmlformats-package.digital-signat&#x75;re-origin"/></Types>'))
  } else {
    const relationships = await zip.file('_rels/.rels').async('string')
    const origin = declaration === 'encoded-relationship' ? 'orig&#105;n' : 'origin'
    assert.match(relationships, /<\/Relationships>/)
    zip.file('_rels/.rels', relationships.replace('</Relationships>',
      `<Relationship Id="signatureOrigin" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/${origin}" Target="custom-signature/origin.sigs"/></Relationships>`))
  }
  zip.file('custom-signature/origin.sigs', '')
  return zip.generateAsync({type:'nodebuffer', compression:'DEFLATE'})
}
