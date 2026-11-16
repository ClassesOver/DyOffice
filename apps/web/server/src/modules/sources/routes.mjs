import { randomUUID } from 'node:crypto'
import { fail, fields, httpUrl, readJson } from '../../http-helpers.mjs'

export async function handleSources(req, res, ctx, { path, send, state }) {
  if (path !== '/api/sources') return false
  if (req.method === 'GET') {
    send(state.sources.map(({ secret, ...source }) => ({ ...source, hasKey: Boolean(secret) })))
    return true
  }
  if (req.method === 'PUT') {
    const value = await readJson(req)
    fields(value, ['id', 'name', 'url', 'apiKey'])
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) fail('数据源名称无效')
    if (value.apiKey !== undefined && typeof value.apiKey !== 'string') fail('密钥格式无效')
    const id = value.id ?? randomUUID()
    if (typeof id !== 'string') fail('数据源 ID 无效')
    const url = httpUrl(value.url)
    const sealed = value.apiKey ? ctx.store.seal(value.apiKey) : undefined
    // Resolve an omitted key against the queued state, not the snapshot taken before the body arrived.
    await ctx.store.update((current) => {
      const previous = current.sources.find((source) => source.id === id)
      const source = { id, name: value.name, url, secret: value.apiKey === undefined ? previous?.secret : sealed }
      current.sources = current.sources.filter((source) => source.id !== id)
      current.sources.push(source)
    })
    send({ id })
    return true
  }
  return false
}
