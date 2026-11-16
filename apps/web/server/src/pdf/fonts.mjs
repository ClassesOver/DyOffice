import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep, isAbsolute } from 'node:path'

const require = createRequire(new URL('../../../../../package.json', import.meta.url))
let fontDir
async function directory() {
  fontDir ??= await realpath(join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts'))
  return fontDir
}

const FILES = new Set([
  'FoxitDingbats.pfb',
  'FoxitFixed.pfb',
  'FoxitFixedBold.pfb',
  'FoxitFixedBoldItalic.pfb',
  'FoxitFixedItalic.pfb',
  'FoxitSerif.pfb',
  'FoxitSerifBold.pfb',
  'FoxitSerifBoldItalic.pfb',
  'FoxitSerifItalic.pfb',
  'FoxitSymbol.pfb',
  'LiberationSans-Bold.ttf',
  'LiberationSans-BoldItalic.ttf',
  'LiberationSans-Italic.ttf',
  'LiberationSans-Regular.ttf',
  'LICENSE_FOXIT',
  'LICENSE_LIBERATION',
])

/** Same-origin standard fonts for the PDF.js viewer. Names outside the set are refused. */
export async function servePdfFonts(request, response, pathname) {
  if (!pathname.startsWith('/pdfjs/standard_fonts/')) return false
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return true
  }
  const name = pathname.slice('/pdfjs/standard_fonts/'.length)
  if (!FILES.has(name)) {
    response.writeHead(404)
    response.end()
    return true
  }
  const root = await directory()
  const file = await realpath(join(root, name))
  const inside = relative(root, file)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    response.writeHead(404)
    response.end()
    return true
  }
  const data = await readFile(file)
  const type = name.endsWith('.ttf') ? 'font/ttf' : name.endsWith('.pfb') ? 'application/octet-stream' : 'text/plain; charset=utf-8'
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=86400',
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(request.method === 'HEAD' ? undefined : data)
  return true
}
