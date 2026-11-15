import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBaseline, compareBaseline } from './compatibility-baseline.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dyoffice-compat-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = {
    'package.json': JSON.stringify({ engines: { node: '>=22.12.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion:3,packages:{'node_modules/typescript':{version:'5.9.3',integrity:'sha512-test'}} }),
    'apps/web/package-lock.json': JSON.stringify({ lockfileVersion:3,packages:{'node_modules/@modelcontextprotocol/sdk':{version:'1.32.2',integrity:'sha512-test'}} }),
    'native/Cargo.lock': 'version = 4\n\n[[package]]\nname = "calamine"\nversion = "0.37.0"\n',
    'fonts/README.md': 'Font license reference, not a legal approval',
    'fonts/Example.ttf': 'font bytes',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const config = { inputs:Object.keys(files).filter(p=>!p.endsWith('.ttf')), fonts:['fonts'], npm:{'package-lock.json':['typescript'],'apps/web/package-lock.json':['@modelcontextprotocol/sdk']}, cargo:['native/Cargo.lock'] }
  return {root,config}
}

test('records deterministic file hashes, distinct lockfile versions and font bytes', async t => {
  const {root,config} = await fixture(t)
  const a = await buildBaseline(root, config)
  const b = await buildBaseline(root, config)
  assert.deepEqual(a,b)
  assert.equal(a.npm['apps/web/package-lock.json']['@modelcontextprotocol/sdk'].version,'1.32.2')
  assert.equal(a.cargo['native/Cargo.lock'][0].version,'0.37.0')
  assert.match(a.files['fonts/Example.ttf'].sha256,/^[a-f0-9]{64}$/)
  assert.deepEqual(compareBaseline(a,b),[])
})

test('rejects dependency or font drift without rewriting the baseline', async t => {
  const {root,config} = await fixture(t)
  const baseline = await buildBaseline(root,config)
  await writeFile(join(root,'fonts/Example.ttf'),'changed font')
  const lock = JSON.parse(await readFile(join(root,'apps/web/package-lock.json'),'utf8'))
  lock.packages['node_modules/@modelcontextprotocol/sdk'].version='9.0.0'
  await writeFile(join(root,'apps/web/package-lock.json'),JSON.stringify(lock))
  const drift = compareBaseline(baseline,await buildBaseline(root,config))
  assert.ok(drift.includes('files.fonts/Example.ttf'))
  assert.ok(drift.includes('npm.apps/web/package-lock.json'))
  assert.equal(baseline.npm['apps/web/package-lock.json']['@modelcontextprotocol/sdk'].version,'1.32.2')
})

test('fails if a required locked package, input, or font directory is missing', async t => {
  const {root,config} = await fixture(t)
  await assert.rejects(buildBaseline(root,{...config,npm:{'package-lock.json':['missing-package']}}),/missing-package/)
  await assert.rejects(buildBaseline(root,{...config,inputs:[...config.inputs,'missing.lock']}),/missing.lock/)
  await assert.rejects(buildBaseline(root,{...config,fonts:['no-fonts']}),/no-fonts/)
})

test('detects added and removed inventory entries', () => {
  const a={schemaVersion:1,files:{a:{sha256:'a'}},npm:{},cargo:{}}
  const b={schemaVersion:1,files:{b:{sha256:'b'}},npm:{},cargo:{}}
  assert.deepEqual(compareBaseline(a,b),['files.a','files.b'])
})

test('allows non-font documentation subdirectories but rejects an empty font root', async t => {
  const {root,config} = await fixture(t)
  const baseline=await buildBaseline(root,config)
  await mkdir(join(root,'fonts/docs'))
  await writeFile(join(root,'fonts/docs/README.md'),'documentation only')
  assert.deepEqual(await buildBaseline(root,config),baseline)
  await rm(join(root,'fonts/Example.ttf'))
  await assert.rejects(buildBaseline(root,config),/No font assets found in fonts/)
})
