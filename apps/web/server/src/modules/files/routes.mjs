import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fail, formats, readBytes } from '../../http-helpers.mjs'

export async function handleFiles(req, res, ctx, { path, send, state }) {
  if (path === '/api/files') {
    if (req.method === 'GET') {
      send(state.files)
      return true
    }
    if (req.method === 'POST') {
      let name
      try { name = decodeURIComponent(req.headers['x-file-name'] || '') }
      catch { fail('文件名无效') }
      const format = extname(name).slice(1).toLowerCase()
      if (!formats.has(format) || name.length > 255 || /[\\/\x00-\x1f]/.test(name)) fail('仅支持 DOCX、XLSX、PPTX、PDF')
      const content = await readBytes(req, 50 * 1024 * 1024)
      if (!content.length) fail('文件为空')
      if (format === 'pdf' ? !content.subarray(0, 5).equals(Buffer.from('%PDF-')) : !content.subarray(0, 2).equals(Buffer.from('PK'))) {
        fail('文件内容与格式不匹配')
      }
      const file = { id: randomUUID(), name, format, size: content.length, updatedAt: new Date().toISOString() }
      await writeFile(join(ctx.filePath, file.id), content, { mode: 0o600 })
      try { await ctx.store.update((current) => current.files.push(file)) }
      catch (error) {
        await unlink(join(ctx.filePath, file.id))
        throw error
      }
      send(file, 201)
      return true
    }
  }
  const fileMatch = path.match(/^\/api\/files\/([a-zA-Z0-9-]+)$/)
  if (fileMatch && req.method === 'GET') {
    const file = state.files.find((entry) => entry.id === fileMatch[1])
    if (!file) fail('文件不存在', 404)
    // Read first: a failed read must answer with a JSON error, not a download named after the file.
    const content = await readFile(join(ctx.filePath, file.id))
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    res.end(content)
    return true
  }
  return false
}
