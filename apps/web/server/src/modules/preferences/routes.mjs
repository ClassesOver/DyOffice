import { fields, readJson } from '../../http-helpers.mjs'

export async function handlePreferences(req, res, ctx, { path, send, state }) {
  if (path !== '/api/preferences') return false
  if (req.method === 'GET') {
    send(state.preferences)
    return true
  }
  if (req.method === 'PUT') {
    const value = await readJson(req)
    fields(value, ['theme', 'language', 'authorName', 'autoSave', 'showAssistant'])
    if (value.theme !== undefined && !['light', 'dark', 'system'].includes(value.theme)) failTheme()
    if (value.language !== undefined && !['zh', 'en'].includes(value.language)) failLanguage()
    for (const key of ['autoSave', 'showAssistant']) {
      if (value[key] !== undefined && typeof value[key] !== 'boolean') failPreference()
    }
    if (value.authorName !== undefined && (typeof value.authorName !== 'string' || value.authorName.length > 100)) failAuthor()
    await ctx.store.update((state) => Object.assign(state.preferences, value))
    send(ctx.store.read().preferences)
    return true
  }
  return false
}

function failTheme() { throw Object.assign(new Error('主题无效'), { status: 400 }) }
function failLanguage() { throw Object.assign(new Error('语言无效'), { status: 400 }) }
function failPreference() { throw Object.assign(new Error('偏好值无效'), { status: 400 }) }
function failAuthor() { throw Object.assign(new Error('作者名称无效'), { status: 400 }) }
