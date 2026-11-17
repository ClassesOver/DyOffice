import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createCredentialVault } from '../../server/src/modules/sources/vault.ts'
import { validateReadOnlySql, validateReadOnlyGrants } from '../../server/src/modules/sources/sql-policy.ts'
import { createSourceEgressPolicy } from '../../server/src/security/egress.ts'

const scope = { deploymentId: 'd', ownerId: 'u', sourceId: 's', reference: 'r', revision: 1 }
test('credential vault binds ciphertext to source/revision and retains old decryption keys', () => {
  const k1 = randomBytes(32).toString('base64'), k2 = randomBytes(32).toString('base64')
  const old = createCredentialVault('old:' + k1), rotated = createCredentialVault('new:' + k2 + ',old:' + k1)
  const sealed = old.seal('secret', scope)
  assert.equal(rotated.open(sealed, scope), 'secret')
  assert.equal(rotated.seal('next', scope).keyId, 'new')
  assert.throws(() => rotated.open(sealed, { ...scope, ownerId: 'other' }))
  assert.throws(() => rotated.open(sealed, { ...scope, revision: 2 }))
  assert.throws(() => createCredentialVault('new:' + k2).open(sealed, scope))
  assert.throws(() => createCredentialVault('').seal('secret', scope))
  for (const value of ['x:bad', 'x:' + k1 + ',x:' + k2, 'x:' + k1 + ',']) assert.throws(() => createCredentialVault(value))
})

test('SQL policy parses one SELECT and positively allows AST nodes, operators and functions', () => {
  for (const dialect of ['postgres', 'mysql', 'starrocks']) {
    for (const sql of ['SELECT 1', 'SELECT count(*) FROM sales', 'WITH x AS (SELECT 1 AS v) SELECT v FROM x', 'SELECT sum(amount) AS total FROM sales WHERE id=2 GROUP BY region', 'SELECT 1 UNION ALL SELECT 2']) assert.equal(typeof validateReadOnlySql(sql, dialect), 'string')
    for (const sql of [
      '', 'SELECT 1; SELECT 2', 'DELETE FROM sales', 'SELECT 1 INTO tmp', 'SELECT * FROM sales FOR UPDATE',
      "SELECT pg_read_file('/etc/passwd')", 'SELECT pg_sleep(10)', 'SELECT sleep(10)', 'SELECT benchmark(10000,1)',
      "SELECT load_file('/etc/passwd')", "SELECT set_config('a','b',false)", 'SELECT custom_unsafe(1)',
      'SELECT pg_catalog.pg_sleep(3)', 'SELECT public.count(1)', 'SELECT * FROM dblink(1)',
      'WITH x AS (DELETE FROM sales RETURNING *) SELECT * FROM x', 'SELECT @x:=1',
      "SELECT 1 INTO OUTFILE '/tmp/t15'", 'SELECT /*!50000 sleep(10) */ 1', 'SELECT * FROM sales LOCK IN SHARE MODE',
    ]) assert.throws(() => validateReadOnlySql(sql, dialect), sql)
  }
})

test('PostgreSQL serialization qualifies ordinary tables while preserving CTE references', () => {
  const sql = validateReadOnlySql('WITH x AS (SELECT count(*) AS n FROM sales) SELECT n FROM x', 'postgres')
  assert.match(sql, /"public"\."sales"/)
  assert.doesNotMatch(sql, /"public"\."x"/)
})

test('MySQL/StarRocks grants attest only explicit SELECT grants on the approved database', () => {
  for (const grants of [["GRANT USAGE ON *.* TO 'reader'@'%'", "GRANT SELECT ON `sales`.* TO 'reader'@'%'"]]) assert.doesNotThrow(() => validateReadOnlyGrants(grants, 'sales'))
  for (const grants of [
    ["GRANT ALL PRIVILEGES ON *.* TO 'root'@'%'"] ,
    ["GRANT SELECT, INSERT ON `sales`.* TO 'reader'@'%'"] ,
    ["GRANT SELECT ON *.* TO 'reader'@'%'"] ,
    ["GRANT SELECT ON `other`.* TO 'reader'@'%'"] ,
    ["GRANT SELECT ON `sales`.* TO 'reader'@'%' WITH GRANT OPTION"] ,
    ["GRANT 'admin'@'%' TO 'reader'@'%'"] ,
    ["GRANT SELECT ON `sales`.* TO 'reader'@'%'", "GRANT FILE ON *.* TO 'reader'@'%'"] ,
  ]) assert.throws(() => validateReadOnlyGrants(grants, 'sales'))
})

test('source egress requires exact approved endpoint/identity and rejects broad or metadata approvals', async () => {
  const target = { kind: 'postgres', endpoint: 'postgresql://localhost:5432', addresses: ['127.0.0.1', '::1'], database: 'sales', username: 'reader', allowInsecure: true }
  const policy = createSourceEgressPolicy([target])
  target.addresses[0] = '169.254.169.254'
  const pinned = await policy.sql('postgres', 'postgresql://reader:secret@localhost:5432/sales')
  assert.ok(['127.0.0.1', '::1'].includes(pinned.address))
  for (const secret of ['postgresql://root:secret@localhost:5432/sales', 'postgresql://reader:secret@localhost:5432/other', 'postgresql://reader:secret@localhost:9/sales', 'postgresql://reader:secret@localhost:5432/sales?host=169.254.169.254']) await assert.rejects(policy.sql('postgres', secret))
  for (const addresses of [['127.0.0.1/32'], ['169.254.169.254'], ['fd00:0ec2:0:0:0:0:0:254'], ['::ffff:127.0.0.1'], ['100.100.100.200']]) assert.throws(() => createSourceEgressPolicy([{ ...target, addresses }]))
  const wrong = createSourceEgressPolicy([{ ...target, addresses: ['192.0.2.1'] }])
  await assert.rejects(wrong.sql('postgres', 'postgresql://reader:s@localhost:5432/sales'))
  await assert.rejects(createSourceEgressPolicy([]).sql('postgres', 'postgresql://reader:s@127.0.0.1:5432/sales'))
})
