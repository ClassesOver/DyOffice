import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { applyMigrations } from '../../server/db/migrate.mjs'
import { createMigrationPool } from '../../server/db/postgres.mjs'
import { createPasswordHasher } from '../../server/auth/passwords.mjs'
import { bootstrapInitialAdmin } from '../../server/auth/bootstrap-admin.mjs'
import { createSessionService } from '../../server/auth/session-core.mjs'
import { createPgLoginThrottle } from '../../server/auth/login-throttle.mjs'
import { createLocalLoginService } from '../../server/auth/login-service.mjs'

const databaseUrl = process.env.DYOFFICE_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DYOFFICE_TEST_DATABASE_URL must point to a disposable test PostgreSQL instance')

const limits = {
  global:{maxAttempts:100,windowMs:60_000},
  ip:{maxAttempts:40,windowMs:60_000},
  account:{maxAttempts:3,windowMs:15*60_000},
}

test('local password login is session-bound, rate-limited across pools, and refuses stale auth-version', {timeout:120_000}, async()=>{
  const pool=createMigrationPool({connectionString:databaseUrl,max:6})
  const passwordHasher=createPasswordHasher({maxConcurrent:2})
  const ipAddress='192.0.2.10'
  const password='Very long valid 🦉 password 2026!'
  try {
    assert.deepEqual(await applyMigrations(pool), ['0001_identity.sql','0002_login_rate_limits.sql'])
    assert.deepEqual(await applyMigrations(pool), [])
    const deploymentId=randomUUID()
    const admin=await bootstrapInitialAdmin({
      pool,passwordHasher,deploymentId,username:'alice.admin',displayName:'Administrator',password,
    })
    const sessions=createSessionService({pool})
    const hmacKey=randomBytes(32)
    const throttle=createPgLoginThrottle({pool,hmacKey,limits})
    const service=await createLocalLoginService({pool,passwordHasher,sessionService:sessions,throttle,deploymentId})
    const allowed=await service.login({username:' ALICE.ADMIN ',password,ipAddress})
    assert.equal(allowed.ok,true)
    assert.equal(allowed.userId,admin.userId)
    assert.match(allowed.cookie,/__Host-dyoffice_session=/)
    const req={headers:{cookie:allowed.cookie.split(';')[0]}}
    assert.equal((await sessions.authenticate(req,{deploymentId})).userId,admin.userId)
    assert.deepEqual(await service.login({username:'alice.admin',password:'wrong password',ipAddress}),
      {ok:false,code:'INVALID_CREDENTIALS'})
    assert.deepEqual(await service.login({username:'alice.admin',password:'still wrong',ipAddress}),
      {ok:false,code:'INVALID_CREDENTIALS'})
    const throttleReplica=createPgLoginThrottle({pool,hmacKey,limits})
    assert.deepEqual(await throttleReplica.consume({deploymentId,usernameNormalized:'alice.admin',ipAddress:'192.0.2.11'}),
      {allowed:false},'shared account quota applies across IPs and instances')
    assert.deepEqual(await service.login({username:'alice.admin',password,ipAddress}),
      {ok:false,code:'RATE_LIMITED'})
    assert.deepEqual(await service.login({username:'missing.admin',password,ipAddress}),
      {ok:false,code:'INVALID_CREDENTIALS'})
    const counters=await pool.query('SELECT count(*)::integer AS n FROM dyoffice_login_rate_buckets')
    assert.ok(counters.rows[0].n >= 4)

    // A password reset that happens while Argon2 verifies invalidates the old version.
    const raceDeployment=randomUUID()
    const raceAdmin=await bootstrapInitialAdmin({
      pool,passwordHasher,deploymentId:raceDeployment,username:'race.admin',displayName:'Race',password,
    })
    const raceThrottle=createPgLoginThrottle({pool,hmacKey,limits})
    let changed=false
    const raceHasher={
      hashPassword:pass=>passwordHasher.hashPassword(pass),
      async verifyPassword(hash,pass){
        const result=await passwordHasher.verifyPassword(hash,pass)
        if(result&&!changed){
          changed=true
          await pool.query('UPDATE dyoffice_users SET auth_version=auth_version+1 WHERE deployment_id=$1 AND id=$2',
            [raceDeployment,raceAdmin.userId])
        }
        return result
      },
    }
    const raceService=await createLocalLoginService({
      pool,passwordHasher:raceHasher,sessionService:sessions,throttle:raceThrottle,deploymentId:raceDeployment,
    })
    assert.deepEqual(await raceService.login({username:'race.admin',password,ipAddress}),
      {ok:false,code:'INVALID_CREDENTIALS'})
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM dyoffice_sessions WHERE user_id=$1',
      [raceAdmin.userId])).rows[0].n),0)
    await pool.query("UPDATE dyoffice_users SET status='disabled',disabled_at=clock_timestamp() WHERE id=$1",
      [admin.userId])
    assert.equal(await sessions.authenticate(req,{deploymentId}),null)
  } finally { await pool.end() }
})
