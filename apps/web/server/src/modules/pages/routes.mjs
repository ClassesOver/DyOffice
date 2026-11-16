import { servePdfFonts } from '../../pdf/fonts.mjs'

export async function handlePage(req, res, ctx, { path, send }) {
  if (path.startsWith('/api/')) return false
  if (await ctx.serveStatic(req, res, path)) return true
  if (await servePdfFonts(req, res, path)) return true
  send({ error: '页面不存在' }, 404)
  return true
}
