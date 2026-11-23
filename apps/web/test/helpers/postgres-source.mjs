import {randomBytes} from 'node:crypto'
import {Pool} from 'pg'

// A real postgres target database: a read-only role with access to one probe
// table, plus a role that lacks CONNECT entirely. Both are real PG denials.
export async function postgresTargets(t, f) {
  const port = new URL(process.env.DYOFFICE_TEST_DATABASE_URL).port || '5432'
  const suffix = randomBytes(4).toString('hex')
  const quote = name => '"' + name + '"'
  const reader = 't15_reader_' + suffix, denied = 't15_denied_' + suffix
  const readerPw = randomBytes(16).toString('hex'), deniedPw = randomBytes(16).toString('hex')
  await f.admin.query(`CREATE ROLE ${quote(reader)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${readerPw}'`)
  await f.admin.query(`CREATE ROLE ${quote(denied)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${deniedPw}'`)
  await f.admin.query(`ALTER ROLE ${quote(reader)} SET default_transaction_read_only=on`)
  await f.admin.query(`GRANT CONNECT ON DATABASE ${quote(f.database)} TO ${quote(reader)}`)
  const targetUrl = new URL(process.env.DYOFFICE_TEST_DATABASE_URL); targetUrl.pathname = '/' + f.database
  const admin = new Pool({ connectionString: targetUrl.href })
  await admin.query(`REVOKE CONNECT ON DATABASE ${quote(f.database)} FROM PUBLIC`)
  await admin.query(`CREATE TABLE t15_probe_${suffix}(i integer, label text, ratio double precision, active boolean, note text)`)
  await admin.query(`INSERT INTO t15_probe_${suffix} VALUES (1,'alpha',1.5,true,NULL),(2,'beta',2.5,false,'x'),(3,'gamma',3.5,true,'y'),(4,'delta',4.5,false,NULL)`)
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${quote(reader)}`)
  await admin.query(`GRANT SELECT ON t15_probe_${suffix} TO ${quote(reader)}`)
  f.cleanup.unshift(async () => {
    await admin.query(`DROP TABLE t15_probe_${suffix}`)
    await admin.query(`REVOKE ALL ON DATABASE ${quote(f.database)} FROM ${quote(reader)}`)
    await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${quote(reader)}`)
    await admin.end()
    await f.admin.query(`DROP ROLE ${quote(reader)}`)
    await f.admin.query(`DROP ROLE ${quote(denied)}`)
  })
  const host = '127.0.0.1:' + port
  return {
    approvals: [reader, denied].map(username => ({ kind: 'postgres', endpoint: 'postgresql://' + host, username, database: f.database, addresses: ['127.0.0.1'], allowInsecure: true })),
    admin,
    probeTable: 't15_probe_' + suffix,
    readerDsn: `postgresql://${reader}:${readerPw}@${host}/${f.database}`,
    deniedDsn: `postgresql://${denied}:${deniedPw}@${host}/${f.database}`,
  }
}
