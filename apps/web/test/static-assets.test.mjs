import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server/application.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dyoffice-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  await mkdir(join(dist, '.vite'), { recursive: true });
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<h1>built workspace</h1>');
  await writeFile(join(dist, 'admin.html'), '<h1>built admin</h1>');
  await writeFile(join(dist, 'assets/app-123.js'), 'window.built=true;');
  await writeFile(join(dist, 'assets/app-123.css'), 'body{color:red}');
  await writeFile(join(dist, 'assets/not-in-manifest.js'), 'private');
  await writeFile(join(dist, '.vite/manifest.json'), JSON.stringify({ app: { file:'assets/app-123.js', css:['assets/app-123.css'] } }));
  const options = { directory:join(root, 'data'), userToken:'user', adminToken:'admin', encryptionKey:'test', assetMode:'built', assetDirectory:dist };
  return { root, dist, options };
}
async function start(t, options) {
  const server = await createApplication(options);
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
test('built mode serves only the manifest assets and preserves same-origin API authorization', async t => {
  const { options } = await fixture(t);
  const origin = await start(t, options);
  assert.equal(await (await fetch(origin+'/')).text(), '<h1>built workspace</h1>');
  assert.equal(await (await fetch(origin+'/admin')).text(), '<h1>built admin</h1>');
  const js = await fetch(origin+'/assets/app-123.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(await js.text(), 'window.built=true;');
  const css = await fetch(origin+'/assets/app-123.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /css/);
  assert.equal((await fetch(origin+'/api/preferences')).status, 401);
  assert.equal((await fetch(origin+'/api/preferences', { headers:{Authorization:'Bearer user'} })).status, 200);
  for (const path of ['/.vite/manifest.json', '/assets/not-in-manifest.js', '/server/application.mjs', '/assets/../package.json', '/assets/%2e%2e%2fpackage.json']) {
    assert.equal((await fetch(origin+path)).status, 404, path);
  }
  assert.equal((await fetch(origin+'/', {method:'POST'})).status, 405);
  const head = await fetch(origin+'/assets/app-123.js', {method:'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
test('built mode fails at startup when its output is absent or unsafe', async t => {
  const { root, dist, options } = await fixture(t);
  await assert.rejects(createApplication({...options,assetDirectory:join(root,'missing')}));
  await assert.rejects(access(options.directory));
  await assert.rejects(createApplication({...options,assetMode:'unknown'}));
  await rm(join(dist, 'assets/app-123.css'));
  await assert.rejects(createApplication(options));
  await writeFile(join(dist, 'assets/app-123.css'), 'body{color:red}');
  await writeFile(join(root, 'secret.js'), 'secret');
  await writeFile(join(dist, '.vite/manifest.json'), JSON.stringify({bad:{file:'../secret.js'}}));
  await assert.rejects(createApplication(options));
  await symlink(join(root, 'secret.js'), join(dist, 'assets/link.js'));
  await writeFile(join(dist, '.vite/manifest.json'), JSON.stringify({bad:{file:'assets/link.js'}}));
  await assert.rejects(createApplication(options));
});

test('a post-start symlink replacement cannot disclose files outside the build', async t => {
  const { root, dist, options } = await fixture(t);
  const origin = await start(t, options);
  await writeFile(join(root, 'secret.js'), 'private-credential');
  await rm(join(dist, 'assets/app-123.js'));
  await symlink(join(root, 'secret.js'), join(dist, 'assets/app-123.js'));
  const response = await fetch(origin+'/assets/app-123.js');
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('private-credential'), false);
});
