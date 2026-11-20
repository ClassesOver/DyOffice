import {createRequire} from 'node:module'
import {dirname,join,sep} from 'node:path'
import {PDF_OPEN_OPTIONS} from '../../../src/editors/pdf-csp.ts'

const require=createRequire(import.meta.url)

/** pdf.js `getDocument` params for server-side parsing: the hardened defaults plus the bundled cmaps and standard fonts. */
export function pdfjsDocumentParams(bytes){
 const root=dirname(require.resolve('pdfjs-dist/package.json'))
 return {data:Uint8Array.from(bytes),...PDF_OPEN_OPTIONS,cMapUrl:join(root,'cmaps')+sep,cMapPacked:true,standardFontDataUrl:join(root,'standard_fonts')+sep}
}
