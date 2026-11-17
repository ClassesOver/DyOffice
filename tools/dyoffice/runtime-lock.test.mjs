import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { checkWorkflows, validateNodeRuntime, lock } from './runtime-lock.mjs'

test('runtime lock covers every existing DyOffice CI workflow and immutable service references', async () => {
  await checkWorkflows()
})
test('runtime admission rejects a different Node patch or executable bytes', () => {
  const good = { version: lock.node.version, platform: 'linux', arch: 'x64', sha256: lock.node.binarySha256 }
  assert.doesNotThrow(() => validateNodeRuntime(good))
  for (const patch of [{version:'22.23.4'},{sha256:'0'.repeat(64)},{arch:'arm64'}]) assert.throws(() => validateNodeRuntime({...good,...patch}))
})
test('unversioned node, mutable images and missing runtime verification fail closed', async () => {
  const files = Object.fromEntries(await Promise.all(lock.workflows.map(async name => [name,await readFile(new URL('../../.github/workflows/'+name,import.meta.url),'utf8')])))
  for (const mutate of [
    text => text.replace(/node-version: ['"]?22\.23\.5['"]?/, 'node-version: 22'),
    text => text.replace(/node tools\/dyoffice\/runtime-lock\.mjs --runtime/, 'node --version'),
  ]) {
    const changed = {...files, [lock.workflows[0]]:mutate(files[lock.workflows[0]])}
    await assert.rejects(() => checkWorkflows(changed))
  }
  const file = 'dyoffice-identity-schema.yml'
  await assert.rejects(() => checkWorkflows({...files,[file]:files[file].replace(/postgres:16@sha256:[a-f0-9]{64}/, 'postgres:16')}))
})
test('runtime guard cannot be conditional, ignored, reordered or moved to another job', async () => {
  const files=Object.fromEntries(await Promise.all(lock.workflows.map(async name=>[name,await readFile(new URL('../../.github/workflows/'+name,import.meta.url),'utf8')])));
  const name=lock.workflows[0], source=files[name];
  for(const change of [
    s=>s.replace('      - name: Verify immutable Node runtime','      - name: Verify immutable Node runtime\n        if: false'),
    s=>s.replace('      - name: Verify immutable Node runtime','      - name: Verify immutable Node runtime\n        if : false'),
    s=>s.replace('      - name: Verify immutable Node runtime','      - name: Verify immutable Node runtime\n        continue-on-error: true'),
    s=>s.replace('      - name: Verify immutable Node runtime','      - run: npm ci\n      - name: Verify immutable Node runtime'),
    s=>s.replace('    timeout-minutes:', '    if: false\n    timeout-minutes:'),
    s=>s.replace('      - name: Verify immutable Node runtime\n        run: node tools/dyoffice/runtime-lock.mjs --runtime\n','')+'\n  fake:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node tools/dyoffice/runtime-lock.mjs --runtime\n',
  ]) await assert.rejects(()=>checkWorkflows({...files,[name]:change(source)}));
})


test('manual non-Node host audit is exact-byte locked, never a general guard exemption', async () => {
  const files=Object.fromEntries(await Promise.all(lock.workflows.map(async name=>[name,await readFile(new URL('../../.github/workflows/'+name,import.meta.url),'utf8')])));
  const name='dyoffice-ubuntu-docker-audit.yml';
  assert.ok(files[name], 'audit must remain in the complete workflow inventory');
  assert.match(lock.manualHostAuditSha256, /^[a-f0-9]{64}$/);
  await checkWorkflows(files);
  for (const mutate of [
    s=>s+'\n',
    s=>s.replace('workflow_dispatch:', 'push:'),
    s=>s.replace('contents: read', 'contents: write'),
    s=>s.replace('ubuntu-24.04', 'ubuntu-latest'),
    s=>s.replace('github.ref ==', 'github.ref !='),
    s=>s.replace('python3 tools/dyoffice/audit-ubuntu-docker.py', 'sudo python3 tools/dyoffice/audit-ubuntu-docker.py'),
  ]) {
    const changed=mutate(files[name]);
    assert.notEqual(changed, files[name]);
    await assert.rejects(()=>checkWorkflows({...files,[name]:changed}), /manual host audit workflow digest/);
  }
  const omitted={...files};delete omitted[name];
  await assert.rejects(()=>checkWorkflows(omitted), /inventory changed/);
  await assert.rejects(()=>checkWorkflows({...files,'dyoffice-extra-audit.yml':files[name]}), /inventory changed/);
  const digest=lock.manualHostAuditSha256;
  try {
    for (const bad of [undefined,'','0'.repeat(64)]) {
      lock.manualHostAuditSha256=bad;
      await assert.rejects(()=>checkWorkflows(files), /manual host audit workflow digest/);
    }
  } finally { lock.manualHostAuditSha256=digest; }
  // A different inventoried workflow cannot borrow the audit's non-Node path.
  await assert.rejects(()=>checkWorkflows({...files,[lock.workflows[0]]:files[name]}));
});

test('audit-only changes trigger runtime-lock CI on both push and pull_request', async () => {
  const files=Object.fromEntries(await Promise.all(lock.workflows.map(async name=>[name,await readFile(new URL('../../.github/workflows/'+name,import.meta.url),'utf8')])));
  const name='dyoffice-web-boundaries.yml';
  const line="      - '.github/workflows/dyoffice-ubuntu-docker-audit.yml'\n";
  assert.equal(files[name].split(line).length-1,2);
  await checkWorkflows(files);
  for (const index of [files[name].indexOf(line),files[name].lastIndexOf(line)]) {
    const changed=files[name].slice(0,index)+files[name].slice(index+line.length);
    await assert.rejects(()=>checkWorkflows({...files,[name]:changed}), /must trigger runtime-lock for audit workflow changes/);
  }
});
