import { withMcp } from '../../../mcp.mjs'
import { fail, fields, httpUrl, publicModel, readJson } from '../../http-helpers.mjs'

function redact(entry) {
  return { ...entry, apiKey: undefined, secret: undefined, hasKey: Boolean(entry.secret) }
}

export async function handleAdmin(req, res, ctx, { path, send, state }) {
  if (path === '/api/models' && req.method === 'GET') {
    send(state.admin.models.filter((model) => model.enabled).map(publicModel))
    return true
  }
  if (path === '/api/admin/config') {
    if (req.method === 'GET') {
      send({ models: state.admin.models.map(redact), mcp: state.admin.mcp.map(redact) })
      return true
    }
    if (req.method === 'PUT') {
      const value = await readJson(req)
      fields(value, ['models', 'mcp'])
      let next
      await ctx.store.update((current) => {
        next = { ...current.admin }
        for (const kind of ['models', 'mcp']) if (value[kind] !== undefined) {
          if (!Array.isArray(value[kind]) || value[kind].length > 50) fail('配置列表无效')
          const ids = new Set()
          next[kind] = value[kind].map((item) => {
            fields(item, kind === 'models' ? ['id', 'model', 'baseUrl', 'apiKey', 'enabled'] : ['id', 'transport', 'url', 'apiKey', 'enabled'])
            if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 100 || ids.has(item.id)) fail('配置 ID 无效或重复')
            ids.add(item.id)
            if (item.enabled !== undefined && typeof item.enabled !== 'boolean') fail('启用状态无效')
            if (item.apiKey !== undefined && (typeof item.apiKey !== 'string' || item.apiKey.length > 8192)) fail('密钥格式无效')
            const previous = current.admin[kind].find((entry) => entry.id === item.id)
            const result = {
              id: item.id,
              enabled: item.enabled ?? true,
              secret: item.apiKey === undefined ? previous?.secret : item.apiKey ? ctx.store.seal(item.apiKey) : undefined,
            }
            if (kind === 'mcp') {
              if (item.transport !== 'http') fail('MCP 仅支持 HTTP')
              return { ...result, transport: 'http', url: httpUrl(item.url) }
            }
            if (typeof item.model !== 'string' || !item.model.trim()) fail('模型名称不能为空')
            return { ...result, model: item.model, baseUrl: httpUrl(item.baseUrl) }
          })
        }
        current.admin = next
      })
      send({ models: next.models.map(redact), mcp: next.mcp.map(redact) })
      return true
    }
  }
  const mcpMatch = path.match(/^\/api\/admin\/mcp\/([^/]+)\/test$/)
  if (mcpMatch && req.method === 'POST') {
    const entry = state.admin.mcp.find((item) => item.id === decodeURIComponent(mcpMatch[1]))
    if (!entry) fail('MCP 服务不存在', 404)
    try {
      send(await withMcp(entry, entry.secret ? ctx.store.unseal(entry.secret) : undefined, async (client) => ({
        ok: true,
        tools: (await client.listTools()).tools.map(({ name, description }) => ({ name, description })),
      })))
    } catch {
      fail('MCP HTTP 连接失败，请检查地址和鉴权', 502)
    }
    return true
  }
  return false
}
