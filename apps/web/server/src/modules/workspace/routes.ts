import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CreateWorkspaceFolder, UpdateWorkspaceFolder, WorkspaceFileQuery } from '../../../../../../packages/web-contracts/src/workspace.ts'
import type { SessionService } from '../auth/sessions.ts'
import { authError } from '../auth/sessions.ts'
import type { createCsrfService } from '../auth/csrf.ts'
import { cookies } from '../auth/csrf.ts'
import { uuidSchema as id, fileParamsSchema as params, emptyQuerySchema as emptyQuery } from '../files/http-schema.ts'
import type { WorkspaceService } from './service.ts'

const nullableId = { anyOf: [id, { type: 'null' }] }
const folderProperties = { name: { type: 'string', minLength: 1, maxLength: 255 }, parentId: nullableId }
const token = (request: FastifyRequest) => cookies(request).session ?? ''
const fileId = (request: FastifyRequest) => (request.params as { id: string }).id
function emptyBody(request: FastifyRequest) { if (request.body !== undefined) throw authError(400) }

export function registerWorkspaceRoutes(app: FastifyInstance, workspace: WorkspaceService, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const credential = token(request)
      if (!credential) throw authError(401)
      const mutation = !['GET','HEAD','OPTIONS'].includes(request.method)
      csrf.originCheck(request, mutation)
      if (mutation) csrf.requireSession(request, credential)
      await sessions.authenticate(credential)
    })
    api.get('/api/v1/workspace/files', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      ext: { type: 'string', enum: ['docx','xlsx','pptx','pdf'] },
      q: { type: 'string', maxLength: 200 },
      id,
      view: { type: 'string', enum: ['all','recent','starred','trash'] },
      sort: { type: 'string', enum: ['modified-asc','modified-desc'] },
      folderId: { anyOf: [id, { type: 'string', const: 'root' }] },
      limit: { type: 'string', pattern: '^(?:0|[1-9][0-9]?|100)$' },
      offset: { type: 'string', pattern: '^(?:0|[1-9][0-9]{0,5}|1000000)$' },
    } } } }, request => {
      const query = request.query as { ext?: WorkspaceFileQuery['ext']; q?: string; id?: string; view?: WorkspaceFileQuery['view']; sort?: WorkspaceFileQuery['sort']; folderId?: string; limit?: string; offset?: string }
      return workspace.listFiles(token(request), { ext: query.ext, q: query.q, id: query.id, view: query.view, sort: query.sort, folderId: query.folderId, limit: query.limit === undefined ? undefined : Number(query.limit), offset: query.offset === undefined ? undefined : Number(query.offset) })
    })
    api.get('/api/v1/workspace/folders', { schema: { querystring: emptyQuery } }, request => workspace.listFolders(token(request)))
    api.post('/api/v1/workspace/folders', { bodyLimit: 4096, schema: { querystring: emptyQuery, body: { type: 'object', additionalProperties: false, required: ['name','parentId'], properties: folderProperties } } }, async (request, reply) => reply.code(201).send(await workspace.createFolder(token(request), request.body as CreateWorkspaceFolder)))
    api.patch('/api/v1/workspace/folders/:id', { bodyLimit: 4096, schema: { params, querystring: emptyQuery, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: folderProperties } } }, request => workspace.updateFolder(token(request), fileId(request), request.body as UpdateWorkspaceFolder))
    api.delete('/api/v1/workspace/folders/:id', { bodyLimit: 4096, schema: { params, querystring: emptyQuery } }, async (request, reply) => {
      emptyBody(request)
      await workspace.deleteFolder(token(request), fileId(request))
      return reply.code(204).send()
    })
    api.put('/api/v1/workspace/files/:id/star', { bodyLimit: 4096, schema: { params, querystring: emptyQuery, body: { type: 'object', additionalProperties: false, required: ['starred'], properties: { starred: { type: 'boolean' } } } } }, async (request, reply) => {
      await workspace.setStar(token(request), fileId(request), request.body as { starred: boolean })
      return reply.code(204).send()
    })
    api.post('/api/v1/workspace/files/:id/open', { bodyLimit: 4096, schema: { params, querystring: emptyQuery } }, async (request, reply) => {
      emptyBody(request)
      await workspace.recordOpen(token(request), fileId(request))
      return reply.code(204).send()
    })
    api.delete('/api/v1/workspace/files/:id/recent', { bodyLimit: 4096, schema: { params, querystring: emptyQuery } }, async (request, reply) => {
      emptyBody(request)
      await workspace.removeRecent(token(request), fileId(request))
      return reply.code(204).send()
    })
    api.patch('/api/v1/workspace/files/:id/folder', { bodyLimit: 4096, schema: { params, querystring: emptyQuery, body: { type: 'object', additionalProperties: false, required: ['folderId'], properties: { folderId: nullableId } } } }, async (request, reply) => {
      await workspace.moveFile(token(request), fileId(request), request.body as { folderId: string | null })
      return reply.code(204).send()
    })
  })
}

