import { revisionEvidence } from './revision-evidence.mjs'
import { createCommitFaultHook } from './commit-fault.mjs'
import { verifyStoredBytes } from './verify-stored.mjs'
// Disposable QA only: isolated test database/local objects; never production mounted.
import { mock } from 'node:test'
import assert from 'node:assert/strict'
import { password } from '../apps/web/test/helpers/identity.mjs'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileFixture, importFile } from '../apps/web/test/helpers/files.mjs'
import { registerAuthRoutes } from '../apps/web/server/src/modules/auth/routes.ts'
import { createLoginThrottle } from '../apps/web/server/src/modules/auth/throttle.ts'
import { createLeaseService } from '../apps/web/server/src/modules/leases/service.ts'
import { createRevisionService } from '../apps/web/server/src/modules/revisions/service.ts'
import { registerFileRoutes } from '../apps/web/server/src/modules/files/routes.ts'
import { createCommandRequestFactory } from '../apps/web/server/src/modules/commands/http-service.ts'
import { registerCommandRoutes } from '../apps/web/server/src/modules/commands/routes.ts'
import { createPostgresCommandRecovery } from '../apps/web/server/src/modules/commands/postgres-recovery.ts'
import { createPostgresCommandRecoveryActions } from '../apps/web/server/src/modules/commands/postgres-recovery-actions.ts'
import { registerCommandRecoveryRoutes } from '../apps/web/server/src/modules/commands/recovery-routes.ts'
import { createCsrfService, cookies } from '../apps/web/server/src/modules/auth/csrf.ts'
const after = [],
  t = { after: (cb) => after.push(cb), mock },
  port = Number(process.env.QA_CONTROLLED_PORT ?? '18768'),
  origin = `http://localhost:${port}`
if (![18768, 18769, 18770, 18771, 18772, 18773].includes(port)) throw Error('Unsupported QA port')
const f = await fileFixture(t, { origin }),
  app = Fastify({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  })
f.cleanup.push(() => app.close())
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
const counts = { proposal: 0, claim: 0, stage: 0, commit: 0 }
let target, secondary, targetPrincipal, initialRevision, verifiedStored, initialProof
app.addHook('onRequest', async (request) => {
  if (request.method !== 'POST') return
  const p = request.url.split('?')[0]
  if (p === '/api/v1/commands/propose') counts.proposal++
  if (p === '/api/v1/commands/execute') counts.claim++
  if (/^\/api\/v1\/files\/[^/]+\/uploads$/.test(p)) counts.stage++
  if (p.endsWith('/commits')) counts.commit++
})
app.addHook(
  'onSend',
  createCommitFaultHook(() =>
    existsSync('qa-controlled/mode') ? readFileSync('qa-controlled/mode', 'utf8').trim() : '',
  ),
)

registerAuthRoutes(app, {
  sessions: f.sessions,
  csrf,
  users: f.users,
  throttle: createLoginThrottle(f.db, f.deploymentId, f.csrfKey),
})
registerFileRoutes(app, f.files, f.sessions, csrf, {
  leases: createLeaseService({ transactions: f.transactions }),
  revisions: createRevisionService({
    transactions: f.transactions,
    objects: f.objects,
    files: f.files,
  }),
})
registerCommandRoutes(app, {
  sessions: f.sessions,
  csrf,
  createRequestCommands: createCommandRequestFactory(f.transactions, () => tool),
})
registerCommandRecoveryRoutes(app, {
  sessions: f.sessions,
  csrf,
  createRequestRecovery: (token) => ({
    lookup: (...a) =>
      createPostgresCommandRecovery({ transactions: f.transactions, token }).lookup(...a),
    abandon: (...a) =>
      createPostgresCommandRecoveryActions({
        transactions: f.transactions,
        token,
        lookupTool: () => tool,
      }).abandon(...a),
  }),
})
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
function headers(reply) {
  return reply
    .header('Cache-Control', 'private, no-store')
    .header('Content-Security-Policy', csp)
    .header('X-Content-Type-Options', 'nosniff')
}
function html(body) {
  return (
    '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>T14 受限实验</title><link rel="stylesheet" href="/qa/controlled/style.css"><body>' +
    '<details><summary>页面资源与 CSP 观察（非完整网络日志）</summary><pre id="qa-network-audit"></pre></details><script src="/qa/controlled/audit.js"></script>' +
    body +
    '</body></html>'
  )
}
app.get('/qa/controlled/audit.js', async (_q, r) =>
  headers(r)
    .type('text/javascript')
    .send(await readFile('qa-controlled/audit.js')),
)
app.get('/qa/controlled/style.css', async (_q, r) =>
  headers(r)
    .type('text/css')
    .send(
      'body{font:17px system-ui;max-width:880px;margin:36px auto;padding:20px;background:#f4f7f8;color:#16202a}main,form{background:white;border:1px solid #bccbd1;padding:24px;border-radius:12px}textarea{display:block;width:95%;margin:12px 0}button,select{padding:12px;margin:8px 8px 8px 0}label{display:block;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f4;padding:12px}li{white-space:pre-wrap;margin:10px}p[role=status]{font-weight:bold}button:disabled{opacity:.5}',
    ),
)
app.get('/qa/controlled/assets/:name', async (q, r) => {
  const name = q.params.name
  if (!/^[A-Za-z0-9_-]+\.(js|css|png|svg|woff2?)$/.test(name)) return r.code(404).send()
  const type = name.endsWith('.js')
    ? 'text/javascript'
    : name.endsWith('.css')
      ? 'text/css'
      : name.endsWith('.png')
        ? 'image/png'
        : 'application/octet-stream'
  return headers(r)
    .type(type)
    .send(await readFile('qa-controlled/dist/' + name))
})
app.get('/qa/controlled/login', async (_q, r) =>
  headers(r)
    .type('text/html')
    .send(
      html(
        '<h1>受限实验登录</h1><p>仅本地合成账户，不用于生产。</p><form><label>用户名 <input name="username" value="alice"></label><label>密码 <input name="password" type="password"></label><button>登录并打开受限实验</button><p role="status"></p></form><script type="module" src="/qa/controlled/assets/login.js"></script>',
      ),
    ),
)
app.get('/qa/controlled', async (q, r) => {
  headers(r)
  const token = cookies(q).session
  if (!token) return r.redirect('/qa/controlled/login')
  const p = await f.sessions.authenticate(token)
  if (p.userId !== f.alice.user.id) return r.code(403).send('Synthetic alice only')
  if (!target) {
    const file = (
      await importFile(
        f,
        token,
        await readFile('apps/docs/tests/fixtures/simple-lo-template.docx'),
        'controlled-lo-template.docx',
      )
    ).file
    target = { fileId: file.fileId }
    initialRevision = file.revision
    targetPrincipal = { deploymentId: f.deploymentId, userId: p.userId, sessionId: p.sessionId }
  }
  const isSecondary = q.query.secondary === '1'
  if (
    Object.keys(q.query).some((key) => key !== 'secondary') ||
    (q.query.secondary !== undefined && !isSecondary)
  )
    return r.code(400).send('Invalid QA selector')
  if (isSecondary && p.sessionId !== targetPrincipal.sessionId)
    return r.code(403).send('Same synthetic session required')
  if (isSecondary && !secondary) {
    const file = (
      await importFile(
        f,
        token,
        await readFile('apps/docs/tests/fixtures/simple-lo-template.docx'),
        'controlled-lo-secondary.docx',
      )
    ).file
    secondary = { fileId: file.fileId }
  }
  const config = JSON.stringify(isSecondary ? secondary : target).replaceAll('<', '\\u003c')
  return r
    .type('text/html')
    .send(
      html(
        '<h1>受限实验 / 非所见即所得</h1><p>仅支持已验证的 LibreOffice 文本模板，不替代原生编辑器。段落以纯文本显示；没有自动审批、自动重试或撤销。</p><main></main><script id="controlled-config" type="application/json">' +
          config +
          '</script><script type="module" src="/qa/controlled/assets/editor.js"></script>',
      ),
    )
})
app.get('/qa/controlled/recovery', async (q, r) => {
  headers(r)
  const token = cookies(q).session
  if (!token) return r.redirect('/qa/controlled/login')
  await f.sessions.authenticate(token)
  const { fileId, commandId } = q.query
  if (![fileId, commandId].every((v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)))
    return r.code(400).send('Invalid recovery pointer')
  const config = JSON.stringify({ fileId, commandId }).replaceAll('<', '\\u003c')
  return r
    .type('text/html')
    .send(
      html(
        '<h1>独立恢复实验</h1><p>不加载编辑器，不重放修改。不清除旧恢复指针。</p><main></main><script id="recovery-config" type="application/json">' +
          config +
          '</script><script type="module" src="/qa/controlled/assets/recovery.js"></script>',
      ),
    )
})
async function observe() {
  if (!targetPrincipal) return { journal: [], fileHead: null }
  const c = await f.ownerPool.connect()
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await c.query(
      "SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true)",
      [targetPrincipal.deploymentId, targetPrincipal.userId, targetPrincipal.sessionId],
    )
    const journal = (
      await c.query(
        'SELECT command_id,state FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3',
        [f.deploymentId, targetPrincipal.userId, target.fileId],
      )
    ).rows
    const fileHead =
      (
        await c.query(
          'SELECT current_revision FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',
          [f.deploymentId, targetPrincipal.userId, target.fileId],
        )
      ).rows[0]?.current_revision ?? null
    const secondaryState = secondary
      ? {
          fileId: secondary.fileId,
          fileHead:
            (
              await c.query(
                'SELECT current_revision FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',
                [f.deploymentId, targetPrincipal.userId, secondary.fileId],
              )
            ).rows[0]?.current_revision ?? null,
          journal: (
            await c.query(
              'SELECT command_id,state FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3',
              [f.deploymentId, targetPrincipal.userId, secondary.fileId],
            )
          ).rows,
        }
      : null
    const revision = (
      await c.query(
        'SELECT id AS revision,sha256,size FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND id=$4',
        [f.deploymentId, targetPrincipal.userId, target.fileId, fileHead],
      )
    ).rows[0]
    const receiptEvidence = await revisionEvidence(c, [
      f.deploymentId,
      targetPrincipal.userId,
      target.fileId,
    ])
    await c.query('COMMIT')
    if (fileHead && verifiedStored?.revision !== fileHead) {
      assert.ok(revision, 'Observed head must have exact revision metadata')
      const bytes = await f.files.readFile(f.alice.token, target.fileId, fileHead)
      const proof = await verifyStoredBytes(
        bytes,
        await readFile('apps/docs/tests/fixtures/simple-lo-template.docx'),
        revision,
        initialRevision,
      )
      await writeFile('qa-controlled/durable.docx', bytes)
      verifiedStored = proof
      if (proof.initial) initialProof = proof
    }
    return {
      journal,
      fileHead,
      secondary: secondaryState,
      initialProof,
      verifiedStored,
      receiptEvidence,
    }
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}
try {
  if (process.env.QA_CONTROLLED_SELFTEST === '1') {
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
    assert.equal(login.statusCode, 200)
    const sessionCookie = login.cookies
      .filter((c) => c.value)
      .map((c) => c.name + '=' + c.value)
      .join('; ')
    const page = await app.inject({
      method: 'GET',
      url: '/qa/controlled',
      headers: { cookie: sessionCookie },
    })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /非所见即所得/)
    const secondPage = await app.inject({
      method: 'GET',
      url: '/qa/controlled?secondary=1',
      headers: { cookie: sessionCookie },
    })
    assert.equal(secondPage.statusCode, 200)
    assert.notEqual(secondary.fileId, target.fileId)
    const observed = await observe()
    assert.equal(observed.secondary.journal.length, 0)
    assert.ok(observed.secondary.fileHead)
    assert.equal(observed.journal.length, 0)
    assert.ok(observed.fileHead)
    assert.equal(observed.receiptEvidence.fileRevisionCount, 1)
    assert.equal(observed.receiptEvidence.revisionCommitCount, 0)
    assert.equal(observed.receiptEvidence.commandUploadBindingCount, 0)
    assert.equal(observed.receiptEvidence.exactCommandReceiptJoinCount, 0)
    assert.equal(observed.verifiedStored.initial, true)
    assert.equal(observed.verifiedStored.nonDocumentPartsEqual, true)
    assert.deepEqual(observed.verifiedStored.paragraphs, ['Hello world', 'Second paragraph'])
    assert.deepEqual(counts, { proposal: 0, claim: 0, stage: 0, commit: 0 })
    const file = await app.inject({
      method: 'GET',
      url: '/api/v1/files/' + target.fileId,
      headers: { cookie: sessionCookie },
    })
    assert.equal(file.statusCode, 200)
    console.log(
      'CONTROLLED AUTH SELFTEST PASS: real login, two distinct LO imports/heads, zero commands/no approval',
    )
  } else {
    await app.listen({ host: '127.0.0.1', port })
    console.log('CONTROLLED GUI READY ' + origin + '/qa/controlled/login')
    while (!existsSync('qa-controlled/stop')) {
      await writeFile(
        'qa-controlled/report.json',
        JSON.stringify({ target, counts, ...(await observe()) }),
      )
      await new Promise((r) => setTimeout(r, 500))
    }
  }
} finally {
  for (const cb of after.reverse()) await cb()
}
