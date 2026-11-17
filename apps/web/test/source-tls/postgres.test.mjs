// Isolated real PG/TLS tests. Set PG_TEST_BIN to a trusted PostgreSQL bin directory.
// No existing database, customer endpoint or global CA store is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Client } from 'pg'
import { createSourceEgressPolicy } from '../../server/src/security/egress.ts'
import { querySqlSource } from '../../server/src/modules/sources/sql.ts'

const execution = {
  maxRows: 2,
  maxResponseBytes: 10000,
  statementTimeoutMs: 2000,
}
async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  )
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
const run = (file, args) =>
  execFileSync(file, args, { stdio: 'pipe', timeout: 30000 })

test(
  'real pinned PostgreSQL TLS queries enforce certificate and role checks',
  { timeout: 90000 },
  async (t) => {
    assert.ok(
      process.env.PG_TEST_BIN,
      'PG_TEST_BIN must point to trusted PostgreSQL binaries; missing prerequisite is not a skip',
    )
    const bin = process.env.PG_TEST_BIN,
      dir = await mkdtemp(join(tmpdir(), 'dyoffice-source-tls-')),
      started = []
    t.after(async () => {
      const failures = []
      for (const data of started) {
        try {
          run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'])
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'Failed to stop disposable PostgreSQL; fixture directory retained',
        )
      await rm(dir, { recursive: true, force: true })
    })
    for (const [name, san] of [
      ['server', 'IP:127.0.0.1'],
      ['wrong-host', 'DNS:not-the-target.invalid'],
      ['wrong-ca', 'DNS:wrong-ca.invalid'],
    ]) {
      run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, name + '.key'),
        '-out',
        join(dir, name + '.crt'),
        '-days',
        '1',
        '-subj',
        '/CN=' + name,
        '-addext',
        'subjectAltName=' + san,
      ])
      await chmod(join(dir, name + '.key'), 0o600)
    }
    async function instance(name, tls = true) {
      const data = join(dir, name + '-data'),
        port = await unusedPort()
      run(join(bin, 'initdb'), [
        '-D',
        data,
        '-U',
        'fixture_owner',
        '-A',
        'trust',
        '--no-locale',
      ])
      const options =
        `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''` +
        (tls
          ? ` -c ssl=on -c ssl_cert_file=${join(dir, name + '.crt')} -c ssl_key_file=${join(dir, name + '.key')}`
          : '')
      run(join(bin, 'pg_ctl'), [
        '-D',
        data,
        '-l',
        join(dir, name + '.log'),
        '-o',
        options,
        'start',
      ])
      started.push(data)
      const admin = new Client({
        host: '127.0.0.1',
        port,
        user: 'fixture_owner',
        database: 'postgres',
      })
      await admin.connect()
      try {
        await admin.query(
          `CREATE ROLE source_reader LOGIN NOINHERIT PASSWORD 'synthetic-test-only'; ALTER ROLE source_reader SET default_transaction_read_only=on; REVOKE CREATE,TEMPORARY ON DATABASE postgres FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE VIEW public.tls_probe AS SELECT ssl, 123.45::numeric AS amount FROM pg_stat_ssl WHERE pid=pg_backend_pid(); GRANT USAGE ON SCHEMA public TO source_reader; GRANT SELECT ON public.tls_probe TO source_reader`,
        )
      } finally {
        await admin.end()
      }
      return {
        port,
        ca: tls ? await readFile(join(dir, name + '.crt'), 'utf8') : undefined,
      }
    }
    const secure = await instance('server'),
      mismatch = await instance('wrong-host'),
      plain = await instance('plain', false)
    const query = async (
      target,
      {
        ca = target.ca,
        user = 'source_reader',
        password = 'synthetic-test-only',
        addresses = ['127.0.0.1'],
      } = {},
    ) => {
      const endpoint = `postgresql://127.0.0.1:${target.port}`
      const policy = createSourceEgressPolicy([
        {
          kind: 'postgres',
          endpoint,
          addresses,
          username: user,
          database: 'postgres',
          ca,
        },
      ])
      return querySqlSource(
        policy,
        'postgres',
        `postgresql://${user}:${password}@127.0.0.1:${target.port}/postgres`,
        'SELECT ssl, amount FROM public.tls_probe',
        execution,
      )
    }
    await t.test(
      'approved certificate completes actual role checks, transaction and cursor over TLS',
      async () => {
        const result = await query(secure)
        assert.deepEqual(result, {
          names: ['ssl', 'amount'],
          types: ['boolean', 'number'],
          rows: [[true, '123.45']],
        })
      },
    )
    await t.test('wrong CA rejects before returning rows', async () => {
      await assert.rejects(
        query(secure, {
          ca: await readFile(join(dir, 'wrong-ca.crt'), 'utf8'),
        }),
        { statusCode: 502 },
      )
    })
    await t.test('trusted certificate with wrong SAN rejects', async () => {
      await assert.rejects(query(mismatch), { statusCode: 502 })
    })
    await t.test('plaintext server cannot downgrade required TLS', async () => {
      await assert.rejects(query(plain, { ca: secure.ca }), { statusCode: 502 })
    })
    await t.test(
      'trusted TLS does not authorize an administrator role',
      async () => {
        await assert.rejects(query(secure, { user: 'fixture_owner' }), {
          statusCode: 403,
        })
      },
    )
    await t.test(
      'unapproved pinned IP is rejected',
      async () => {
        await assert.rejects(query(secure, { addresses: ['127.0.0.2'] }), {
          statusCode: 400,
        })
      },
    )
  },
)
