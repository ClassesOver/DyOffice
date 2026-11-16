import test from 'node:test'
import assert from 'node:assert/strict'
import { restrictedIdentityFixture } from '../helpers/restricted-identity.mjs'
import { password } from '../helpers/identity.mjs'
import { waitForDatabaseLock } from '../helpers/restricted.mjs'
import { tokenHash } from '../../server/src/modules/auth/sessions.ts'

for (const purpose of ['activate', 'reset']) test(`${purpose} crossing the action deadline rolls back password, credentials and audit`, { timeout: 15000 }, async t => {
  const f = await restrictedIdentityFixture(t)
  const signed = await f.sessions.login('owner', password)
  const created = await f.users.create(signed.token, { username: 'deadline_user' })
  let action = created.action
  if (purpose === 'reset') {
    await f.users.redeemAction(action.token, 'activate', password)
    action = (await f.users.issueReset(signed.token, created.user.id)).action
  }
  const snapshot = async () => ({
    user: (await f.pool.query('SELECT status,password_hash,password_changed_at,auth_version,password_reset_required FROM users WHERE id=$1', [created.user.id])).rows[0],
    action: (await f.pool.query('SELECT consumed_at,auth_version FROM password_action_tokens WHERE token_hash=$1', [tokenHash(action.token)])).rows[0],
    events: Number((await f.pool.query("SELECT count(*) FROM auth_security_events WHERE subject_user_id=$1 AND event='password_action_consumed'", [created.user.id])).rows[0].count),
  })
  const before = await snapshot()
  let enteredFinalWrite = false, announceFinalWrite
  const finalWrite = new Promise(resolve => { announceFinalWrite = resolve })
  const notice = message => {
    if (message.message === 'action deadline final write entered') { enteredFinalWrite = true; announceFinalWrite() }
  }
  const observe = connection => { connection.removeListener('notice', notice); connection.on('notice', notice) }
  f.authPool.on('acquire', observe)
  f.cleanup.push(async () => f.authPool.removeListener('acquire', observe))
  // Delay the last write, after credential invalidation and password mutation.
  // The real runtime auth role executes the service; only test setup owns DDL.
  await f.pool.query(`CREATE FUNCTION delay_password_action_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event='password_action_consumed' THEN RAISE NOTICE 'action deadline final write entered'; PERFORM pg_sleep(1); END IF; RETURN NEW; END $$;
    CREATE TRIGGER delay_password_action_audit BEFORE INSERT ON auth_security_events FOR EACH ROW EXECUTE FUNCTION delay_password_action_audit()`)
  await f.pool.query("UPDATE password_action_tokens SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE user_id=$1 AND consumed_at IS NULL", [created.user.id])
  const first = f.users.redeemAction(action.token, purpose, 'new violet river lanterns drift 9357')
  const firstRejected = assert.rejects(first, { statusCode: 400 })
  await Promise.race([finalWrite, first.then(() => { throw new Error('First redemption finished before the final-write barrier') })])
  const secondRejected = assert.rejects(() => f.users.redeemAction(action.token, purpose, 'another violet river lanterns drift 9371'), { statusCode: 400 })
  await waitForDatabaseLock(f, 'auth')
  await Promise.all([firstRejected, secondRejected])
  assert.equal(enteredFinalWrite, true, 'deadline must be crossed after the initial authority check')
  assert.deepEqual(await snapshot(), before)
})
