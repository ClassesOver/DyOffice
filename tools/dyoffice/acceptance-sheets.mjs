import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Disposable acceptance harness. Uses the existing restricted-role File API,
// normal password login and root controller; never substitutes a native backend.
const root = fileURLToPath(new URL('../../', import.meta.url))
const manifestPath = process.env.DYOFFICE_TEST_HOST_MANIFEST ?? join(root, '.dyoffice-native-build/host-manifest.json')
const built = join(root, 'apps/web/dist-sheets')
const checksOnly = process.argv.length === 3 && process.argv[2] === '--check'
if (process.argv.length > (checksOnly ? 3 : 2)) throw new Error('Usage: node tools/dyoffice/acceptance-sheets.mjs [--check]')

async function preflight() {
  const failures = []
  if (process.getuid?.() !== 0) failures.push('Native controller requires root (see apps/web/worker/HOST-RUNTIME.md).')
  const database = process.env.DYOFFICE_TEST_DATABASE_URL
  try {
    const url = new URL(database)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/dyoffice_test(?:_[a-z0-9_]+)?$/.test(url.pathname)) throw new Error()
  } catch { failures.push('Set DYOFFICE_TEST_DATABASE_URL to an isolated loopback dyoffice_test database.') }
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bytes = await readFile(manifest.nativeBinary)
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.nativeSha256) throw new Error()
  } catch { failures.push('Build the original native engine: RUSTUP_TOOLCHAIN=1.93.0 npm run build:web:native -- --with-probe') }
  try { await readFile(join(built, '.vite/native-assets.json')) }
  catch { failures.push('Build the renderer: npm run build:sheets --workspace=@dyoffice/web') }
  if (failures.length) {
    for (const failure of failures) console.error(failure)
    return false
  }
  return true
}

if (!await preflight()) process.exitCode = 1
else if (checksOnly) console.log('Acceptance prerequisites verified; database connectivity and systemd launch are checked on startup.')
else await start()

async function start() {
  const cleanups = [], t = { after: operation => cleanups.push(operation) }
  let server, closing
  const close = () => closing ??= (async () => {
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    for (const operation of cleanups.reverse()) {
      try { await operation() } catch { console.error('Acceptance cleanup failed; check disposable database and native units.'); process.exitCode = 1 }
    }
  })()
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
  try {
    const { fileFixture, importFile } = await import('../../apps/web/test/helpers/files.mjs')
    const { password } = await import('../../apps/web/test/helpers/identity.mjs')
    const { sheetsGateway } = await import('../../apps/web/test/helpers/sheets-gateway.mjs')
    const { sandboxFixture } = await import('../../apps/web/test/helpers/native-sandbox.mjs')
    const { createXlsxNativeWorker } = await import('../../apps/web/worker/src/native/xlsx.ts')
    const directory = await mkdtemp(join(tmpdir(), 'dyoffice-acceptance-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' })
    let fixture, fileId
    const loginScript = `document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const status=document.querySelector('[role=status]');const target='/native-xlsx/?fileId='+document.querySelector('form').dataset.fileId;try{const existing=await fetch('/api/v1/auth/me');if(existing.ok){location.href=target;return}const challenge=await(await fetch('/api/v1/auth/csrf')).json();const response=await fetch('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':challenge.csrfToken},body:JSON.stringify({username:'alice',password:document.querySelector('[name=password]').value})});if(response.status===409){location.href=target;return}if(!response.ok)throw new Error('Login failed');location.href=target}catch(error){status.textContent=error.message}})`
    server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (request, response) => {
      if (!fixture) { response.writeHead(503); response.end('Starting acceptance environment'); return }
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" })
        response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>T09 本地验收</title><h1>T09 本地验收</h1><p>临时测试环境，账号 alice。仅导入仓库验收文件，退出服务后删除临时数据。</p><form data-file-id="${fileId}"><label>测试密码 <input name="password" type="password" autocomplete="current-password" required></label><button>登录并打开验收工作簿</button></form><p role="status"></p><p>修改 A2 为 21.25，检查 B2=42.5，保存后点击编辑器的 Download saved version，在真实 Excel 中复开。</p><p>C2 日期应为 2024-01-01；D2=12.50%；E2=1234.57 kg；Revenue 名称和图表保留。F2=SUM(Revenue) 应随 A2 修改重算。</p><script src="/acceptance.js"></script></html>`)
        return
      }
      if (request.method === 'GET' && request.url === '/acceptance.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); response.end(loginScript); return
      }
      fixture.app.routing(request, response)
    })
    const port = Number(process.env.DYOFFICE_ACCEPTANCE_PORT ?? 3443)
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid acceptance port')
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    const origin = `https://127.0.0.1:${port}`
    const gateway = await sheetsGateway(t), sandbox = await sandboxFixture('native')
    await sandbox.run(Buffer.from('acceptance-startup'), async () => {})
    fixture = await fileFixture(t, { origin, nativeSheetsDirectory: built, sheetsNative: createXlsxNativeWorker(sandbox), sheetsPlanner: gateway.planWorkbookSave, sheetsPackageReader: gateway.readWorkbookPackage })
    await fixture.preferences.update(fixture.alice.token, { language: 'en', autoSave: false, showAssistant: false })
    const original = await readFile(join(root, 'apps/web/test/fixtures/sheets/acceptance.xlsx'))
    const opened = await importFile(fixture, fixture.alice.token, original, 't09-acceptance.xlsx')
    fileId = opened.file.fileId
    console.log(`Local acceptance: ${origin}/`)
    console.log(`Disposable test account: alice\nTest password: ${password}`)
    console.log('Use the normal login form. Keep this process running; Ctrl+C removes its temporary files, database and roles.')
    console.log('The TLS certificate is self-signed. This harness binds only to 127.0.0.1 and is not a production server.')
  } catch (error) {
    await close()
    throw error
  }
}
