// Disposable integration harness only. Never mounted by the production app.
import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { password } from '../apps/web/test/helpers/identity.mjs'
import Fastify from 'fastify'
import { registerAuthRoutes } from '../apps/web/server/src/modules/auth/routes.ts'
import { createLoginThrottle } from '../apps/web/server/src/modules/auth/throttle.ts'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileFixture, docxBytes, importFile } from '../apps/web/test/helpers/files.mjs'
import { createLeaseService } from '../apps/web/server/src/modules/leases/service.ts'
import { createCommandRequestFactory } from '../apps/web/server/src/modules/commands/http-service.ts'
import { createPostgresCommandRecovery } from '../apps/web/server/src/modules/commands/postgres-recovery.ts'
import { createPostgresCommandRecoveryActions } from '../apps/web/server/src/modules/commands/postgres-recovery-actions.ts'
import { registerCommandRecoveryRoutes } from '../apps/web/server/src/modules/commands/recovery-routes.ts'
import { createCsrfService, cookies } from '../apps/web/server/src/modules/auth/csrf.ts'
import { commandHash } from '../apps/web/server/src/modules/commands/approval.ts'
const after = [],
  t = { after: (cb) => after.push(cb), mock },
  origin = 'http://localhost:18767',
  f = await fileFixture(t, { origin }),
  app = Fastify({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  })
f.cleanup.push(() => app.close())
app.addHook('onError', async (_request, _reply, error) => {
  console.error(JSON.stringify({ code: error.code, message: error.message, stack: error.stack }))
})
const tool = {
  name: 'docs.replace_text.v1',
  schemaVersion: 1,
  effect: 'document_write',
  executionMode: 'live_editor',
  requiresActiveEditor: true,
  requiredScopes: ['files:write'],
  maxDurationMs: 1000,
  inputSchema: {},
  outputSchema: {},
}
const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin, key: f.csrfKey })
registerAuthRoutes(app, {
  sessions: f.sessions,
  csrf,
  users: f.users,
  throttle: createLoginThrottle(f.db, f.deploymentId, f.csrfKey),
})
let target,
  targetPrincipal,
  mutations = 0,
  lookups = 0,
  lost = false
registerCommandRecoveryRoutes(app, {
  sessions: f.sessions,
  csrf,
  createRequestRecovery: (token) => ({
    lookup: async (...args) => {
      lookups++
      return createPostgresCommandRecovery({ transactions: f.transactions, token }).lookup(...args)
    },
    abandon: async (...args) => {
      mutations++
      const result = await createPostgresCommandRecoveryActions({
        transactions: f.transactions,
        token,
        lookupTool: () => tool,
      }).abandon(...args)
      const mode = existsSync('qa-recovery/mode')
        ? readFileSync('qa-recovery/mode', 'utf8').trim()
        : ''
      if (mode === 'lost' && !lost) {
        lost = true
        throw Object.assign(Error('Synthetic dropped response after committed abandonment'), {
          statusCode: 503,
        })
      }
      if (mode === 'stall') await new Promise((r) => setTimeout(r, 10000))
      return result
    },
  }),
})
const headers = (reply) =>
  reply
    .header('Cache-Control', 'private, no-store')
    .header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    )
const html = (body) =>
  `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>T14 Recovery QA</title><link rel="stylesheet" href="/qa/recovery/style.css"><body>${body}</body></html>`
app.get('/qa/recovery/style.css', async (_req, reply) =>
  reply
    .type('text/css')
    .send(
      'body{font:17px system-ui;max-width:860px;margin:48px auto;padding:20px;color:#16202a;background:#f4f7f8}section,form{background:white;padding:28px;border:1px solid #bacbd1;border-radius:12px}button{margin:12px 12px 8px 0;padding:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f4;padding:16px}label{display:block;margin:16px 0}input{margin-right:8px}p[role=status]{font-weight:bold}',
    ),
)
app.get('/qa/recovery/login', async (_req, reply) =>
  headers(reply)
    .type('text/html')
    .send(
      html(
        '<h1>恢复页测试登录</h1><p>仅本地合成账户。退出会使旧命令无法在新会话恢复。</p><form><label>用户名 <input name="username" value="alice"></label><label>密码 <input name="password" type="password"></label><button>登录并打开恢复页</button><button type="button" id="logout">退出当前会话</button><p role="status"></p></form><script type="module" src="/qa/recovery/login.js"></script>',
      ),
    ),
)
app.get('/qa/recovery/login.js', async (_req, reply) =>
  reply
    .type('text/javascript')
    .send(
      `const status=document.querySelector('[role=status]');async function csrf(){const r=await fetch('/api/v1/auth/csrf',{mode:'same-origin',redirect:'error',cache:'no-store'});return (await r.json()).csrfToken}document.querySelector('form').onsubmit=async e=>{e.preventDefault();try{const data=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/v1/auth/login',{mode:'same-origin',redirect:'error',method:'POST',headers:{'content-type':'application/json','x-csrf-token':await csrf()},body:JSON.stringify(data)});if(!r.ok)throw Error('登录失败 '+r.status);location.assign('/qa/recovery')}catch(e){status.textContent=e.message}};document.querySelector('#logout').onclick=async()=>{const r=await fetch('/api/v1/auth/logout',{mode:'same-origin',redirect:'error',method:'POST',headers:{'x-csrf-token':await csrf()}});status.textContent=r.ok?'已退出':'退出失败'};`,
    ),
)
app.get('/qa/recovery/recovery.js', async (_req, reply) =>
  reply.type('text/javascript').send(await readFile('apps/web/dist-command-recovery/recovery.js')),
)
app.get('/qa/recovery', async (req, reply) => {
  headers(reply)
  const token = cookies(req).session
  if (!token) return reply.redirect('/qa/recovery/login')
  const p = await f.sessions.authenticate(token)
  if (!target) {
    if (p.userId !== f.alice.user.id)
      return reply.code(403).send('First setup requires synthetic alice')
    const file = (await importFile(f, token, await docxBytes())).file,
      editorId = randomUUID(),
      lease = await createLeaseService({ transactions: f.transactions }).acquireLease(
        token,
        file.fileId,
        { editorId },
      ),
      envelope = {
        commandId: randomUUID(),
        fileId: file.fileId,
        baseRevision: file.revision,
        editorGeneration: 1,
        leaseEpoch: lease.leaseEpoch,
        argsHash: commandHash({ text: 'hello' }),
        payload: { toolName: tool.name, arguments: { text: 'hello' } },
      },
      service = createCommandRequestFactory(
        f.transactions,
        () => tool,
      )({ token, editorId, editorGeneration: 1 }).service,
      proposal = await service.proposeCommand(envelope)
    await service.approveCommand(envelope, proposal.digest)
    await service.beginExecution(envelope, proposal.digest)
    target = { fileId: file.fileId, commandId: envelope.commandId }
    targetPrincipal = { deploymentId: f.deploymentId, userId: p.userId, sessionId: p.sessionId }
  }
  const config = JSON.stringify(target).replaceAll('<', '\\u003c')
  return reply
    .type('text/html')
    .send(
      html(
        `<p>独立恢复实验，不加载原生编辑器。<a href="/qa/recovery/login">切换测试登录</a></p><main></main><script id="recovery-config" type="application/json">${config}</script><script type="module" src="/qa/recovery/recovery.js"></script>`,
      ),
    )
})

// Administrative QA observation only: retain verified IDs, never the session token.
// Explicit transaction-local scope is required because the owner also obeys FORCE RLS.
async function observeDurableState() {
  if (!target || !targetPrincipal) return { journal: [], fileHead: null }
  const c = await f.ownerPool.connect()
  try {
    await c.query('BEGIN')
    await c.query(
      "SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true)",
      [targetPrincipal.deploymentId, targetPrincipal.userId, targetPrincipal.sessionId],
    )
    const journal = (
      await c.query(
        'SELECT state FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4 AND file_id=$5',
        [
          targetPrincipal.deploymentId,
          targetPrincipal.userId,
          targetPrincipal.sessionId,
          target.commandId,
          target.fileId,
        ],
      )
    ).rows
    const fileHead =
      (
        await c.query(
          'SELECT current_revision FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',
          [targetPrincipal.deploymentId, targetPrincipal.userId, target.fileId],
        )
      ).rows[0]?.current_revision ?? null
    await c.query('COMMIT')
    return { journal, fileHead }
  } catch (error) {
    await c.query('ROLLBACK')
    throw error
  } finally {
    c.release()
  }
}
try {
  if (process.env.QA_RECOVERY_SELFTEST === '1') {
    const challenge = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/csrf',
      headers: { origin },
    })
    assert.equal(challenge.statusCode, 200)
    const cookie = challenge.cookies.map((c) => c.name + '=' + c.value).join('; ')
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin, cookie, 'x-csrf-token': challenge.json().csrfToken },
      payload: { username: 'alice', password },
    })
    assert.equal(login.statusCode, 200, 'Synthetic login failed: ' + login.statusCode)
    const sessionCookie = login.cookies
      .filter((c) => c.value)
      .map((c) => c.name + '=' + c.value)
      .join('; ')
    const page = await app.inject({
      method: 'GET',
      url: '/qa/recovery',
      headers: { cookie: sessionCookie },
    })
    assert.equal(page.statusCode, 200, 'Synthetic recovery page failed: ' + page.statusCode)
    const observed = await observeDurableState()
    assert.equal(observed.journal.length, 1)
    assert.equal(observed.journal[0].state, 'unknown_outcome')
    assert.ok(observed.fileHead)
    console.log(
      'RECOVERY AUTH SELFTEST PASS: csrf challenge, login, same-session recovery page and scoped durable observation',
    )
  } else {
    await app.listen({ host: '127.0.0.1', port: 18767 })
    console.log('RECOVERY GUI READY ' + origin + '/qa/recovery/login')
    while (!existsSync('qa-recovery/stop')) {
      await writeFile(
        'qa-recovery/report.json',
        JSON.stringify({
          target,
          mutations,
          lookups,
          ...(await observeDurableState()),
        }),
      )
      await new Promise((r) => setTimeout(r, 500))
    }
  }
} finally {
  for (const cb of after.reverse()) await cb()
}
