import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createCredentialVault } from '../../server/src/modules/sources/vault.ts'
import { validateReadOnlySql, validateReadOnlyGrants } from '../../server/src/modules/sources/sql-policy.ts'
import { createSourceEgressPolicy } from '../../server/src/security/egress.ts'
import { createSourceService } from '../../server/src/modules/sources/service.ts'

test('invalid configured egress targets cannot fall back to unset policy', () => {
  for (const egressTargets of [null, false, 0]) {
    assert.throws(() => createSourceService({transactions: {}, egressTargets}), /Invalid source egress configuration/)
  }
})

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

test('PostgreSQL accepts a monthly sum with typed date bounds within the configured scope', () => {
  const scope = { defaultSchema: 'public', allowedSchemas: ['sales'], allowedTables: ['sales.orders'] }
  const sql = "SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month, sum(paid_amount) AS total FROM sales.orders WHERE paid_at >= DATE '2026-01-01' AND paid_at < DATE '2026-03-01' GROUP BY 1 ORDER BY 1"
  const normalized = validateReadOnlySql(sql, 'postgres', scope)
  assert.match(normalized, /FROM "sales"\."orders"/)
  assert.match(normalized, /DATE '2026-01-01'.*DATE '2026-03-01'/)
  assert.throws(() => validateReadOnlySql(sql.replace('sales.orders', 'sales.other'), 'postgres', scope))
  assert.throws(() => validateReadOnlySql(sql.replace('to_char', 'public.to_char'), 'postgres', scope))
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

test('ordinary database transport is the default without a configured database target; pinned TLS is still honored',async()=>{
  for (const [kind,scheme,port] of [['postgres','postgresql',5432],['mysql','mysql',3306],['starrocks','starrocks',9030]]) {
    const dsn=scheme+'://reader:test-only@127.0.0.1:'+port+'/sales'
    const target={kind,endpoint:scheme+'://127.0.0.1:'+port,addresses:['127.0.0.1'],username:'reader',database:'sales',allowInsecure:false}
    // Without an approved database target, a user-entered host may reach only public addresses.
    const publicDsn=dsn.replace('127.0.0.1','8.8.8.8')
    assert.equal((await createSourceEgressPolicy([],{allowUnlistedSql:true}).sql(kind,publicDsn)).tls,false)
    for (const host of ['127.0.0.1','10.0.0.5','172.16.3.4','192.168.1.10','100.64.0.1','169.254.169.254','[::1]','[fd00::1]','[fe80::1]','[::ffff:10.0.0.1]','[2001:db8::1]','[2002:a00:1::1]','localhost'])
      await assert.rejects(createSourceEgressPolicy([],{allowUnlistedSql:true}).sql(kind,dsn.replace('127.0.0.1',host)),/not approved/,host)
    // An administrator-approved private target stays reachable.
    assert.equal((await createSourceEgressPolicy([target],{allowUnlistedSql:true}).sql(kind,dsn)).tls,true)
    await assert.rejects(createSourceEgressPolicy([target],{allowUnlistedSql:true}).sql(kind,dsn.replace('/sales','/other')))
  }
})

test('public address helpers accept only globally routable unicast',async()=>{
  const {publicAddress,publicIpv6}=await import('../../server/src/security/ip-ranges.ts')
  for (const ip of ['8.8.8.8','203.208.40.1','192.30.255.112','2606:4700:4700::1111','2400:3200::1','2001:4860:4860::8888']) assert.equal(publicAddress(ip),true,ip)
  for (const ip of ['127.0.0.1','10.1.1.1','100.64.0.1','::','::1','fc00::1','fd12:3456::1','fe80::1','ff02::1','::ffff:8.8.8.8','64:ff9b::808:808','2001:db8::1','2001::1','2002:808:808::1','not-an-ip']) assert.equal(publicAddress(ip),false,ip)
  assert.equal(publicIpv6('2606:4700:4700::1111%eth0'),true)
})

test('EXTRACT accepts fixed date parts only, in both dialects, and its source is still checked', () => {
  for (const [dialect, sql] of [
    ['postgres', 'SELECT EXTRACT(QUARTER FROM order_date)::int AS q, SUM(paid_amount) AS paid FROM sales.orders GROUP BY 1'],
    ['postgres', 'SELECT EXTRACT(epoch FROM paid_at) AS t FROM sales.orders'],
    ['starrocks', 'SELECT EXTRACT(year FROM order_date) AS y, COUNT(*) AS n FROM orders GROUP BY 1'],
  ]) assert.doesNotThrow(() => validateReadOnlySql(sql, dialect, { defaultSchema: 'db' }), sql)
  for (const sql of [
    'SELECT EXTRACT(foo FROM order_date) AS q FROM sales.orders',
    "SELECT EXTRACT(year FROM (SELECT pg_read_file('x'))) AS q FROM sales.orders",
    'SELECT EXTRACT(year FROM pg_sleep(10)) AS q FROM sales.orders',
  ]) assert.throws(() => validateReadOnlySql(sql, 'postgres', { defaultSchema: 'db' }), /approved read-only SELECT/, sql)
})

test('INTERVAL literals are accepted only as a plain duration', () => {
  for (const [dialect, sql] of [
    ['postgres', "SELECT order_date + INTERVAL '1 month' AS d FROM sales.orders"],
    ['postgres', "SELECT COUNT(*) AS n FROM sales.orders WHERE order_date >= current_date - INTERVAL '7 days'"],
    ['starrocks', 'SELECT order_date + INTERVAL 1 MONTH AS d FROM orders'],
  ]) assert.doesNotThrow(() => validateReadOnlySql(sql, dialect, { defaultSchema: 'db' }), sql)
  for (const sql of [
    "SELECT order_date + INTERVAL '1 fortnight' AS d FROM sales.orders",
    "SELECT order_date + INTERVAL '1 month; DROP TABLE x' AS d FROM sales.orders",
  ]) assert.throws(() => validateReadOnlySql(sql, 'postgres', { defaultSchema: 'db' }), /approved read-only SELECT/, sql)
})

test('column alias lists are refused because re-serialization would corrupt them; DOUBLE PRECISION casts are accepted', () => {
  assert.throws(() => validateReadOnlySql('SELECT g.x FROM generate_series(1, 3) AS g(x)', 'postgres', { defaultSchema: 'db' }), /approved read-only SELECT/)
  assert.match(validateReadOnlySql('SELECT x FROM generate_series(1, 3) AS x', 'postgres', { defaultSchema: 'db' }), /generate_series/)
  assert.doesNotThrow(() => validateReadOnlySql('SELECT SUM(paid_amount)::double precision AS p FROM sales.orders', 'postgres', { defaultSchema: 'db' }))
})
